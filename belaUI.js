/*
    belaUI - web UI for the BELABOX project
    Copyright (C) 2020-2021 BELABOX project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

const http = require('http');
const finalhandler = require('finalhandler');
const serveStatic = require('serve-static');
const ws = require('ws');
const { exec, execSync, spawn, spawnSync, execFileSync, execFile } = require("child_process");
const fs = require('fs')
const crypto = require('crypto');
const path = require('path');
const dns = require('dns');
const bcrypt = require('bcrypt');
const process = require('process');

const SETUP_FILE = 'setup.json';
const CONFIG_FILE = 'config.json';
const AUTH_TOKENS_FILE = 'auth_tokens.json';

const BCRYPT_ROUNDS = 10;
const ACTIVE_TO = 15000;

/* Disable localization for any CLI commands we run */
process.env['LANG'] = 'C';
/* Make sure apt-get doesn't expect any interactive user input */
process.env['DEBIAN_FRONTEND'] = 'noninteractive';

/* Read the config and setup files */
const setup = JSON.parse(fs.readFileSync(SETUP_FILE, 'utf8'));
console.log(setup);

let belacoderExec, belacoderPipelinesDir;
if (setup.belacoder_path) {
  belacoderExec = setup.belacoder_path + '/belacoder';
  belacoderPipelinesDir = setup.belacoder_path + '/pipeline';
} else {
  belacoderExec = "/usr/bin/belacoder";
  belacoderPipelinesDir = "/usr/share/belacoder/pipelines";
}

let srtlaSendExec;
if (setup.srtla_path) {
  srtlaSendExec = setup.srtla_path + '/srtla_send';
} else {
  srtlaSendExec = "/usr/bin/srtla_send";
}

function checkExecPath(path) {
  try {
    fs.accessSync(path, fs.constants.R_OK);
  } catch (err) {
    console.log(`\n\n${path} not found, double check the settings in setup.json`);
    process.exit(1);
  }
}

checkExecPath(belacoderExec);
checkExecPath(srtlaSendExec);


/* Read the revision numbers */
function getRevision(cmd) {
  try {
    return execSync(cmd).toString().trim();
  } catch (err) {
    return 'unknown revision';
  }
}

const revisions = {};
try {
  revisions['belaUI'] = fs.readFileSync('revision', 'utf8');
} catch(err) {
  revisions['belaUI'] = getRevision('git rev-parse --short HEAD');
}
revisions['belacoder'] = getRevision(`${belacoderExec} -v`);
revisions['srtla'] = getRevision(`${srtlaSendExec} -v`);
// Only show a BELABOX image version if it exists
try {
  revisions['BELABOX image'] = fs.readFileSync('/etc/belabox_img_version', 'utf8').trim();
} catch(err) {};
console.log(revisions);

let config;
let sshPasswordHash;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  console.log(config);
  sshPasswordHash = config.ssh_pass_hash;
  delete config.ssh_pass_hash;
} catch (err) {
  console.log(`Failed to open the config file: ${err.message}. Creating an empty config`);
  config = {};
}


/* tempTokens stores temporary login tokens in memory,
   persistentTokens stores login tokens to the disc */
const tempTokens = {};
let persistentTokens;
try {
  persistentTokens = JSON.parse(fs.readFileSync(AUTH_TOKENS_FILE, 'utf8'));
} catch(err) {
  persistentTokens = {};
}

function saveConfig() {
  config.ssh_pass_hash = sshPasswordHash;
  const c = JSON.stringify(config);
  delete config.ssh_pass_hash;
  fs.writeFileSync(CONFIG_FILE, c);
}

function savePersistentTokens() {
  fs.writeFileSync(AUTH_TOKENS_FILE, JSON.stringify(persistentTokens));
}


/* Initialize the server */
const staticHttp = serveStatic("public");

const server = http.createServer(function(req, res) {
  const done = finalhandler(req, res);
  staticHttp(req, res, done);
});

const wss = new ws.Server({ server });
wss.on('connection', function connection(conn) {
  conn.lastActive = getms();

  if (!config.password_hash) {
    conn.send(buildMsg('status', {set_password: true}));
  }

  conn.on('message', function incoming(msg) {
    console.log(msg);
    try {
      msg = JSON.parse(msg);
      handleMessage(conn, msg);
    } catch (err) {
      console.log(`Error parsing client message: ${err.message}`);
    }
  });
});


/* Misc helpers */
const oneHour = 3600 * 1000;
const oneDay = 24 * oneHour;

function getms() {
  const [sec, ns] = process.hrtime();
  return sec * 1000 + Math.floor(ns / 1000 / 1000);
}


/* WS helpers */
function buildMsg(type, data, id = undefined) {
  const obj = {};
  obj[type] = data;
  obj.id = id;
  return JSON.stringify(obj);
}

function broadcastMsgLocal(type, data, activeMin = 0, except = undefined) {
  const msg = buildMsg(type, data);
  for (const c of wss.clients) {
    if (c !== except && c.lastActive >= activeMin && c.isAuthed) c.send(msg);
  }
  return msg;
}

function broadcastMsg(type, data, activeMin = 0) {
  const msg = broadcastMsgLocal(type, data, activeMin);
  if (remoteWs && remoteWs.isAuthed) {
    remoteWs.send(msg);
  }
}

function broadcastMsgExcept(conn, type, data) {
  broadcastMsgLocal(type, data, 0, conn);
  if (remoteWs && remoteWs.isAuthed) {
    const msg = buildMsg(type, data, conn.senderId);
    remoteWs.send(msg);
  }
}


/* Read the list of pipeline files */
function readDirAbsPath(dir) {
  const files = fs.readdirSync(dir);
  const basename = path.basename(dir);
  const pipelines = {};

  for (const f in files) {
    const name = basename + '/' + files[f];
    const id = crypto.createHash('sha1').update(name).digest('hex');
    const path = dir + files[f];
    pipelines[id] = {name: name, path: path};
  }

  return pipelines;
}

function getPipelines() {
  const ps = {};
  if (setup['hw'] == 'jetson') {
    Object.assign(ps, readDirAbsPath(belacoderPipelinesDir + '/jetson/'));
  }
  Object.assign(ps, readDirAbsPath(belacoderPipelinesDir + '/generic/'));

  return ps;
}

function searchPipelines(id) {
  const pipelines = getPipelines();
  if (pipelines[id]) return pipelines[id].path;
  return null;
}

// pipeline list in the format needed by the frontend
function getPipelineList() {
  const pipelines = getPipelines();
  const list = {};
  for (const id in pipelines) {
    list[id] = pipelines[id].name;
  }
  return list;
}


/* Network interface list */
let netif = {};

function updateNetif() {
  exec("ifconfig", (error, stdout, stderr) => {
    if (error) {
      console.log(error.message);
      return;
    }

    let foundNewInt = false;
    const newints = {};

    wiFiDeviceListStartUpdate();

    const interfaces = stdout.split("\n\n");
    for (const int of interfaces) {
      try {
        const name = int.split(':')[0];

        let inetAddr = int.match(/inet (\d+\.\d+\.\d+\.\d+)/);
        if (inetAddr) inetAddr = inetAddr[1];

        // update the list of WiFi devices
        if (name && name.match('^wlan')) {
          let hwAddr = int.match(/ether ([0-9a-f:]+)/);
          if (hwAddr) {
            wiFiDeviceListAdd(name, hwAddr[1], inetAddr);
          }
        }

        if (name == 'lo' || name.match('^docker') || name.match('^l4tbr')) continue;

        if (!inetAddr) continue;

        let txBytes = int.match(/TX packets \d+  bytes \d+/);
        txBytes = parseInt(txBytes[0].split(' ').pop());
        if (netif[name]) {
          tp = txBytes - netif[name]['txb'];
        } else {
          tp = 0;
        }

        const enabled = (netif[name] && netif[name].enabled == false) ? false : true;
        newints[name] = {ip: inetAddr, txb: txBytes, tp, enabled};

        if (!netif[name] || netif[name].ip != inetAddr) {
          foundNewInt = true;
        }
      } catch (err) {};
    }
    netif = newints;

    broadcastMsg('netif', netif, getms() - ACTIVE_TO);

    if (foundNewInt && isStreaming) {
      updateSrtlaIps();
    }

    if (wiFiDeviceListEndUpdate()) {
      console.log("updated wifi devices");
      // a delay seems to be needed before NM registers new devices
      setTimeout(wifiUpdateDevices, 1000);
    }
  });
}
updateNetif();
setInterval(updateNetif, 1000);

function countActiveNetif() {
  let count = 0;
  for (const int in netif) {
    if (netif[int].enabled) count++;
  }
  return count;
}

function handleNetif(conn, msg) {
  const int = netif[msg['name']];
  if (!int) return;

  if (int.ip != msg.ip) return;

  if (msg['enabled'] === true || msg['enabled'] === false) {
    if (!msg['enabled'] && int.enabled && countActiveNetif() == 1) {
      notificationSend(conn, "netif_disable_all", "error", "Can't disable all networks", 10);
    } else {
      int.enabled = msg['enabled'];
      if (isStreaming) {
        updateSrtlaIps();
      }
    }
  }

  conn.send(buildMsg('netif', netif));
}


/*
  WiFi device list / status maintained by periodic ifconfig updates

  It tracks and detects changes by device name, physical (MAC) addresses and
  IPv4 address. It allows us to only update the WiFi status via nmcli when
  something has changed, because NM is very CPU / power intensive compared
  to the periodic ifconfig polling that belaUI is already doing
*/
let wifiDeviceHwAddr = {};
let wiFiDeviceListIsModified = false;
let wiFiDeviceListIsUpdating = false;

function wiFiDeviceListStartUpdate() {
  if (wiFiDeviceListIsUpdating) {
    throw "Called while an update was already in progress";
  }

  for (const i in wifiDeviceHwAddr) {
    wifiDeviceHwAddr[i].removed = true;
  }
  wiFiDeviceListIsUpdating = true;
  wiFiDeviceListIsModified = false
}

function wiFiDeviceListAdd(ifname, hwAddr, inetAddr) {
  if (!wiFiDeviceListIsUpdating) {
    throw "Called without starting an update";
  }

  if (wifiDeviceHwAddr[ifname]) {
    if (wifiDeviceHwAddr[ifname].hwAddr != hwAddr) {
      wifiDeviceHwAddr[ifname].hwAddr = hwAddr;
      wiFiDeviceListIsModified = true;
    }
    if (wifiDeviceHwAddr[ifname].inetAddr != inetAddr) {
      wifiDeviceHwAddr[ifname].inetAddr = inetAddr;
      wiFiDeviceListIsModified = true;
    }
    wifiDeviceHwAddr[ifname].removed = false;
  } else {
    wifiDeviceHwAddr[ifname] = {
      hwAddr,
      inetAddr
    };
    wiFiDeviceListIsModified = true;
  }
}

function wiFiDeviceListEndUpdate() {
  if (!wiFiDeviceListIsUpdating) {
    throw "Called without starting an update";
  }

  for (const i in wifiDeviceHwAddr) {
    if (wifiDeviceHwAddr[i].removed) {
      delete wifiDeviceHwAddr[i];
      wiFiDeviceListIsModified = true;
    }
  }

  wiFiDeviceListIsUpdating = false;
  return wiFiDeviceListIsModified;
}

function wifiDeviceListGetAddr(ifname) {
  if (wifiDeviceHwAddr[ifname]) {
    return wifiDeviceHwAddr[ifname].hwAddr;
  }
}


/* NetworkManager / nmcli helpers */
function nmConnsGet(fields) {
  try {
    const result = execFileSync("nmcli", [
      "--terse",
      "--fields",
      fields,
      "connection",
      "show",
    ]).toString("utf-8").split("\n");
    return result;

  } catch ({message}) {
    console.log(`nmConnsGet err: ${message}`);
  }
}

function nmConnGetFields(uuid, fields) {
  try {
    const result = execFileSync("nmcli", [
      "--terse",
      "--escape", "no",
      "--get-values",
      fields,
      "connection",
      "show",
      uuid,
    ]).toString("utf-8").split("\n");
    return result;

  } catch ({message}) {
    console.log(`nmConnGetFields err: ${message}`);
  }
}

function nmConnDelete(uuid, callback) {
  execFile("nmcli", ["conn", "del", uuid], function (error, stdout, stderr) {
    let success = true;
    if (error || !stdout.match("successfully deleted")) {
      console.log(`nmConnDelete err: ${stdout}`);
      success = false;
    }

    if (callback) {
      callback(success);
    }
  });
}

function nmConnect(uuid, callback) {
  execFile("nmcli", ["conn", "up", uuid], function (error, stdout, stderr) {
    let success = true;
    if (error || !stdout.match("^Connection successfully activated")) {
      console.log(`nmConnect err: ${stdout}`);
      success = false;
    }

    if (callback) {
      callback(success);
    }
  });
}

function nmDisconnect(uuid, callback) {
  execFile("nmcli", ["conn", "down", uuid], function (error, stdout, stderr) {
    let success = true;
    if (error || !stdout.match("successfully deactivated")) {
      console.log(`nmDisconnect err: ${stdout}`);
      success = false;
    }

    if (callback) {
      callback(success);
    }
  });
}

function nmDevices(fields) {
  try {
    const result = execFileSync("nmcli", [
      "--terse",
      "--fields",
      fields,
      "device",
      "status",
    ]).toString("utf-8").split("\n");
    return result;

  } catch ({message}) {
    console.log(`nmDevices err: ${message}`);
  }
}

function nmRescan(device, callback) {
  const args = ["device", "wifi", "rescan"];
  if (device) {
    args.push("ifname");
    args.push(device);
  }
  execFile("nmcli", args, function (error, stdout, stderr) {
    let success = true;
    if (error || stdout != "") {
      console.log(`nmRescan err: ${stdout}`);
      success = false;
    }

    if (callback) {
      callback(success);
    }
  });
}

function nmScanResults(fields) {
  try {
    const result = execFileSync("nmcli", [
      "--terse",
      "--fields",
      fields,
      "device",
      "wifi",
    ]).toString("utf-8").split("\n");
    return result;

  } catch ({message}) {
    console.log(`nmScanResults err: ${message}`);
  }
}

// parses : separated values, with automatic \ escape detection and stripping
function nmcliParseSep(value) {
  return value.split(/(?<!\\):/).map(a => a.replace(/\\:/g, ':'));
}


/*
  NetworkManager / nmcli based Wifi Manager

  Structs:

  WiFi list <wifiIfs>:
  {
    'mac': <wd>
  }

  WiFi id to MAC address mapping <wifiIdToHwAddr>:
  {
    id: 'mac'
  }

  Wifi device <wd>:
  {
    'id', // numeric id for the adapter - temporary for each belaUI execution
    'ifname': 'wlanX',
    'conn': 'uuid' or undefined; // the active connection
    'available': Map{<an>},
    'saved': {<sn>}
  }

  Available network <an>:
  {
    active, // is it currently connected?
    ssid,
    signal: 0-100,
    security,
    freq
  }

  Saved networks {<sn>}:
  {
    ssid: uuid,
  }
*/
let wifiIfId = 0;
let wifiIfs = {};
let wifiIdToHwAddr = {};

/* Builds the WiFi status structure sent over the network from the <wd> structures */
function wifiBuildMsg() {
  const ifs = {};
  for (const i in wifiIfs) {
    const id = wifiIfs[i].id;
    const s = wifiIfs[i];

    ifs[id] = {
      ifname: s.ifname,
      conn: s.conn,
      available: Array.from(s.available.values()),
      saved: s.saved
    };
  }

  return ifs;
}

function wifiBroadcastState() {
  broadcastMsg('status', {wifi: wifiBuildMsg()});
}


function wifiUpdateSavedConns() {
  let connections = nmConnsGet("uuid,type");
  if (connections === undefined) return;

  for (const i in wifiIfs) {
    wifiIfs[i].saved = {};
  }

  for (const connection of connections) {
    try {
      const [uuid, type] = nmcliParseSep(connection);

      if (type !== "802-11-wireless") continue;

      // Get the device the connection is bound to and the ssid
      const [ssid, macTmp] = nmConnGetFields(uuid, "802-11-wireless.ssid,802-11-wireless.mac-address");

      if (!ssid || !macTmp) continue;

      const macAddr = macTmp.toLowerCase();
      if (wifiIfs[macAddr]) {
        wifiIfs[macAddr].saved[ssid] = uuid;
      }
    } catch (err) {
      console.log(`Error getting the nmcli connection information: ${err.message}`);
    }
  }
}

function wifiUpdateScanResult() {
  const wifiNetworks = nmScanResults("active,ssid,signal,security,freq,device");
  if (!wifiNetworks) return;

  for (const i in wifiIfs) {
    wifiIfs[i].available = new Map();
  }

  for (const wifiNetwork of wifiNetworks) {
    const [active, ssid, signal, security, freq, device] =
      nmcliParseSep(wifiNetwork);

    if (ssid == null || ssid == "") continue;

    const hwAddr = wifiDeviceListGetAddr(device);
    if (!wifiIfs[hwAddr] || (active != 'yes' && wifiIfs[hwAddr].available.has(ssid))) continue;

    wifiIfs[hwAddr].available.set(ssid, {
      active: (active == 'yes'),
      ssid,
      signal: parseInt(signal),
      security,
      freq: parseInt(freq),
    });
  }

  wifiBroadcastState();
}

/*
  The WiFi scan results are updated some time after a rescan command is issued /
  some time after a new WiFi adapter is plugged in.
  This function sets up a number of timers to broadcast the updated scan results
  with the expectation that eventually it will capture any relevant new results
*/
function wifiScheduleScanUpdates() {
  setTimeout(wifiUpdateScanResult, 1000);
  setTimeout(wifiUpdateScanResult, 3000);
  setTimeout(wifiUpdateScanResult, 5000);
  setTimeout(wifiUpdateScanResult, 10000);
}

function wifiUpdateDevices() {
  let newDevices = false;
  let statusChange = false;

  let networkDevices = nmDevices("device,type,state,con-uuid");
  if (!networkDevices) return;

  // sorts the results alphabetically by interface name
  networkDevices.sort();

  // mark all WiFi adapters as removed
  for (const i in wifiIfs) {
    wifiIfs[i].removed = true;
  }

  // Rebuild the id-to-hwAddr map
  wifiIdToHwAddr = {};

  for (const networkDevice of networkDevices) {
    try {
      const [ifname, type, state, connUuid] = nmcliParseSep(networkDevice);
      const conn = (connUuid != '') ? connUuid : null;

      if (type !== "wifi" || state == "unavailable") continue;

      const hwAddr = wifiDeviceListGetAddr(ifname);
      if (!hwAddr) continue;

      if (wifiIfs[hwAddr]) {
        // the interface is still available
        delete wifiIfs[hwAddr].removed;

        if (ifname != wifiIfs[hwAddr].ifname) {
          wifiIfs[hwAddr].ifname = ifname;
          statusChange = true;
        }
        if (conn != wifiIfs[hwAddr].conn) {
          wifiIfs[hwAddr].conn = conn;
          statusChange = true;
        }
      } else {
        const id = wifiIfId++;

        wifiIfs[hwAddr] = {
          id,
          ifname,
          conn,
          available: new Map(),
          saved: {}
        };
        newDevices = true;
        statusChange = true;
      }
      wifiIdToHwAddr[wifiIfs[hwAddr].id] = hwAddr;
    } catch (err) {
      console.log(`Error getting the nmcli WiFi device information: ${err.message}`);
    }
  }

  // delete removed adapters
  for (const i in wifiIfs) {
    if (wifiIfs[i].removed) {
      delete wifiIfs[i];
      statusChange = true;
    }
  }

  if (newDevices) {
    wifiUpdateSavedConns();
    wifiScheduleScanUpdates();
  }
  if (statusChange) {
    wifiUpdateScanResult();
  }
  if (newDevices || statusChange) {
    wifiBroadcastState();
  }
  console.log(wifiIfs);

  return statusChange;
}

function wifiRescan() {
  nmRescan(undefined, function(success) {
    /* A rescan request will fail if a previous one is in progress,
       but we still attempt to update the results */
    wifiUpdateScanResult();
    wifiScheduleScanUpdates();
  });
}

/* Searches saved connections in wifiIfs by UUID */
function wifiSearchConnection(uuid) {
  let connFound;
  for (const i in wifiIdToHwAddr) {
    const macAddr = wifiIdToHwAddr[i];
    for (const s in wifiIfs[macAddr].saved) {
      if (wifiIfs[macAddr].saved[s] == uuid) {
        connFound = i;
        break;
      }
    }
  }

  return connFound;
}

function wifiDisconnect(uuid) {
  if (wifiSearchConnection(uuid) === undefined) return;

  nmDisconnect(uuid, function(success) {
    if (success) {
      wifiUpdateScanResult();
      wifiScheduleScanUpdates();
    }
  });
}

function wifiForget(uuid) {
  if (wifiSearchConnection(uuid) === undefined) return;

  nmConnDelete(uuid, function(success) {
    if (success) {
      wifiUpdateSavedConns();
      wifiUpdateScanResult();
      wifiScheduleScanUpdates();
    }
  });
}

function wifiDeleteFailedConns() {
  const connections = nmConnsGet("uuid,type,timestamp");
  for (const c in connections) {
    const [uuid, type, ts] = nmcliParseSep(connections[c]);
    if (type !== "802-11-wireless") continue;
    if (ts == 0) {
      nmConnDelete(uuid);
    }
  }
}

function wifiNew(conn, msg) {
  if (!msg.device || !msg.ssid) return;
  if (!wifiIdToHwAddr[msg.device]) return;

  const device = wifiIfs[wifiIdToHwAddr[msg.device]].ifname;

  const args = [
    "-w",
    "15",
    "device",
    "wifi",
    "connect",
    msg.ssid,
    "ifname",
    device
  ];

  if (msg.password) {
    args.push('password');
    args.push(msg.password);
  }

  const senderId = conn.senderId;
  execFile("nmcli", args, function(error, stdout, stderr) {
    if (error || stdout.match('^Error:')) {
      wifiDeleteFailedConns();

      if (stdout.match('Secrets were required, but not provided')) {
        conn.send(buildMsg('wifi', {new: {error: "auth", device: msg.device}}, senderId));
      } else {
        conn.send(buildMsg('wifi', {new: {error: "generic", device: msg.device}}, senderId));
      }
    } else if (stdout.match('successfully activated')) {
      wifiUpdateSavedConns();
      wifiUpdateScanResult();

      conn.send(buildMsg('wifi', {new: {success: true, device: msg.device}}, senderId));
    }
  });
}

function wifiConnect(conn, uuid) {
  const deviceId = wifiSearchConnection(uuid);
  if (deviceId === undefined) return;

  const senderId = conn.senderId;
  nmConnect(uuid, function(success) {
    wifiUpdateScanResult();
    conn.send(buildMsg('wifi', {connect: success, device: deviceId}, senderId));
  });
}

function handleWifi(conn, msg) {
  for (const type in msg) {
    switch(type) {
      case 'connect':
        wifiConnect(conn, msg[type]);
        break;
      case 'disconnect':
        wifiDisconnect(msg[type]);
        break;
      case 'scan':
        wifiRescan();
        break;
      case 'new':
        wifiNew(conn, msg[type]);
        break;
      case 'forget':
        wifiForget(msg[type]);
        break;
    }
  }
}


/* Remote */
/*
  A brief remote protocol version history:
  1 - initial remote release
  2 - belaUI password setting feature
  3 - apt update feature
  4 - ssh manager
  5 - wifi manager
  6 - notification sytem
*/
const remoteProtocolVersion = 6;
const remoteEndpoint = 'wss://remote.belabox.net/ws/remote';
const remoteTimeout = 5000;
const remoteConnectTimeout = 10000;

let remoteWs = undefined;
let remoteStatusHandled = false;
function handleRemote(conn, msg) {
  for (const type in msg) {
    switch (type) {
      case 'auth/encoder':
        if (msg[type] === true) {
          conn.isAuthed = true;
          sendInitialStatus(conn)
          broadcastMsgLocal('status', {remote: true}, getms() - ACTIVE_TO);
          console.log('remote: authenticated');
        } else {
          broadcastMsgLocal('status', {remote: {error: 'key'}}, getms() - ACTIVE_TO);
          remoteStatusHandled = true;
          conn.terminate();
          console.log('remote: invalid key');
        }
        break;
    }
  }
}

let prevRemoteBindAddr = -1;
function getRemoteBindAddr() {
  const netList = Object.keys(netif);

  if (netList.length < 1) {
    prevRemoteBindAddr = -1;
    return undefined;
  }

  prevRemoteBindAddr++;
  if (prevRemoteBindAddr >= netList.length) {
    prevRemoteBindAddr = 0;
  }

  return netif[netList[prevRemoteBindAddr]].ip;
}

function remoteHandleMsg(msg) {
  try {
    msg = JSON.parse(msg);
    if (msg.remote) {
      handleRemote(this, msg.remote);
    }
    delete msg.remote;

    if (Object.keys(msg).length >= 1) {
      this.senderId = msg.id;
      handleMessage(this, msg, true);
      delete this.senderId;
    }

    this.lastActive = getms();
  } catch(err) {
    console.log(`Error handling remote message: ${err.message}`);
  }
}

let remoteConnectTimer;
function remoteClose() {
  remoteConnectTimer = setTimeout(remoteConnect, 1000);
  this.removeListener('close', remoteClose);
  this.removeListener('message', remoteHandleMsg);
  remoteWs = undefined;

  if (!remoteStatusHandled) {
    broadcastMsgLocal('status', {remote: {error: 'network'}}, getms() - ACTIVE_TO);
  }
}

function remoteConnect() {
  if (remoteConnectTimer !== undefined) {
    clearTimeout(remoteConnectTimer);
    remoteConnectTimer = undefined;
  }

  if (config.remote_key) {
    const bindIp = getRemoteBindAddr();
    if (!bindIp) {
      remoteConnectTimer = setTimeout(remoteConnect, 1000);
      return;
    }
    console.log(`remote: trying to connect via ${bindIp}`);

    remoteStatusHandled = false;
    remoteWs = new ws(remoteEndpoint, (options = {localAddress: bindIp}));
    remoteWs.isAuthed = false;
    // Set a longer initial connection timeout - mostly to deal with slow DNS
    remoteWs.lastActive = getms() + remoteConnectTimeout - remoteTimeout;
    remoteWs.on('error', function(err) {
      console.log('remote error: ' + err.message);
    });
    remoteWs.on('open', function() {
      const auth_msg = {remote: {'auth/encoder':
                        {key: config.remote_key, version: remoteProtocolVersion}
                       }};
      this.send(JSON.stringify(auth_msg));
    });
    remoteWs.on('close', remoteClose);
    remoteWs.on('message', remoteHandleMsg);
  }
}

function remoteKeepalive() {
  if (remoteWs) {
    if ((remoteWs.lastActive + remoteTimeout) < getms()) {
      remoteWs.terminate();
    }
  }
}
remoteConnect();
setInterval(remoteKeepalive, 1000);

function setRemoteKey(key) {
  config.remote_key = key;
  saveConfig();

  if (remoteWs) {
    remoteStatusHandled = true;
    remoteWs.terminate();
  }
  remoteConnect();

  broadcastMsg('config', config);
}


/* Notification system */
/*
  conn - send it to a specific client, or undefined to broadcast
  name - identifier for the notification, e.g. 'belacoder'
  type - 'success', 'warning', 'error'
  msg - the human readable notification message
  duration - 0-never expires
             or number of seconds until the notification expires
             * an expired notification is hidden by the UI and removed from persistent notifications
  isPersistent - show it to every new client, conn must be undefined for broadcast
  isDismissable - is the user allowed to hide it?
*/
let persistentNotifications = new Map();

function notificationSend(conn, name, type, msg, duration = 0, isPersistent = false, isDismissable = true) {
  if (isPersistent && conn != undefined) {
    console.log("error: attempted to send persistent unicast notification");
    return false;
  }

  const notification = {
                         name,
                         type,
                         msg,
                         is_dismissable: isDismissable,
                         is_persistent: isPersistent,
                         duration
                       };
  let doSend = true;
  if (isPersistent) {
    let pn = persistentNotifications.get(name);
    if (pn) {
      // Rate limiting to once every second
      if (pn.last_sent && ((pn.last_sent + 1000) > getms())) {
        doSend = false;
      }
    } else {
      pn = {};
      persistentNotifications.set(name, pn)
    }

    Object.assign(pn, notification);
    pn.updated = getms();

    if (doSend) {
      pn.last_sent = getms();
    }
  }

  if (!doSend) return;

  const notificationMsg = {
                            show: [notification]
                          };
  if (conn) {
    conn.send(buildMsg('notification', notificationMsg, conn.senderId));
  } else {
    broadcastMsg('notification', notificationMsg);
  }

  return true;
}

function notificationBroadcast(name, type, msg, duration = 0, isPersistent = false, isDismissable = true) {
  notificationSend(undefined, name, type, msg, duration, isPersistent, isDismissable);
}

function notificationRemove(name) {
  persistentNotifications.delete(name);

  const msg = { remove: [name] };
  broadcastMsg('notification', msg);
}

function _notificationIsLive(n) {
  if (n.duration === 0) return 0;

  const remainingDuration = Math.ceil(n.duration - (getms() - n.updated) / 1000);
  if (remainingDuration <= 0) {
    persistentNotifications.delete(n.name);
    return false;
  }
  return remainingDuration;
}

function notificationExists(name) {
  let pn = persistentNotifications.get(name);
  if (!pn) return;

  if (_notificationIsLive(pn) !== false) return pn;
}

function notificationSendPersistent(conn) {
  const notifications = [];
  for (const n of persistentNotifications) {
    const remainingDuration = _notificationIsLive(n[1]);
    if (remainingDuration !== false) {
      notifications.push({
        name: n[1].name,
        type: n[1].type,
        msg: n[1].msg,
        is_dismissable: n[1].is_dismissable,
        is_persistent: n[1].is_persistent,
        duration: remainingDuration
      });
    }
  }

  const msg = { show: notifications };
  conn.send(buildMsg('notification', msg));
}


/* Hardware monitoring */
let sensors = {};
function updateSensorsJetson() {
  try {
    let socVoltage = fs.readFileSync('/sys/bus/i2c/drivers/ina3221x/6-0040/iio:device0/in_voltage0_input', 'utf8');
    socVoltage = parseInt(socVoltage) / 1000.0;
    socVoltage = `${socVoltage.toFixed(3)} V`;
    sensors['SoC voltage'] = socVoltage;
  } catch(err) {};

  try {
    let socCurrent = fs.readFileSync('/sys/bus/i2c/drivers/ina3221x/6-0040/iio:device0/in_current0_input', 'utf8');
    socCurrent = parseInt(socCurrent) / 1000.0;
    socCurrent = `${socCurrent.toFixed(3)} A`;
    sensors['SoC current'] = socCurrent;
  } catch(err) {};

  try {
    let socTemp = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    socTemp = parseInt(socTemp) / 1000.0;
    socTemp = `${socTemp.toFixed(1)} °C`;
    sensors['SoC temperature'] = socTemp;
  } catch (err) {};

  broadcastMsg('sensors', sensors, getms() - ACTIVE_TO);
}
if (setup['hw'] == 'jetson') {
  updateSensorsJetson();
  setInterval(updateSensorsJetson, 1000);
}


function startError(conn, msg, id = undefined) {
  const originalId = conn.senderId;
  if (id !== undefined) {
    conn.senderId = id;
  }

  notificationSend(conn, "start_error", "error", msg, 10);

  if (id !== undefined) {
    conn.senderId = originalId;
  }
  conn.send(buildMsg('status', {is_streaming: false}));
  return false;
}

function setBitrate(params) {
  const minBr = 300; // Kbps

  if (params.max_br == undefined) return null;
  if (params.max_br < minBr || params.max_br > 12000) return null;

  config.max_br = params.max_br;
  saveConfig();

  fs.writeFileSync(setup.bitrate_file, minBr*1000 + "\n"
                   + config.max_br*1000 + "\n");

  spawnSync("killall", ['-HUP', "belacoder"], { detached: true});

  return config.max_br;
}

function updateConfig(conn, params, callback) {
  // delay
  if (params.delay == undefined)
    return startError(conn, "audio delay not specified");
  if (params.delay < -2000 || params.delay > 2000)
    return startError(conn, "invalid delay " + params.delay);

  // pipeline
  if (params.pipeline == undefined)
    return startError(conn, "pipeline not specified");
  let pipeline = searchPipelines(params.pipeline);
  if (pipeline == null)
    return startError(conn, "pipeline not found");

  // bitrate
  let bitrate = setBitrate(params);
  if (bitrate == null)
    return startError(conn, "invalid bitrate range: ");

  // srt latency
  if (params.srt_latency == undefined)
    return startError(conn, "SRT latency not specified");
  if (params.srt_latency < 100 || params.srt_latency > 10000)
    return startError(conn, "invalid SRT latency " + params.srt_latency + " ms");

  // srt streamid
  if (params.srt_streamid == undefined)
    return startError(conn, "SRT streamid not specified");

  // srtla addr & port
  if (params.srtla_addr == undefined)
    return startError(conn, "SRTLA address not specified");
  if (params.srtla_port == undefined)
    return startError(conn, "SRTLA port not specified");
  if (params.srtla_port <= 0 || params.srtla_port > 0xFFFF)
    return startError(conn, "invalid SRTLA port " + params.srtla_port);

  // Save the sender's ID in case we'll have to use it in the exception handler
  const senderId = conn.senderId;
  dns.lookup(params.srtla_addr, function(err, address, family) {
    if (err == null) {
      config.delay = params.delay;
      config.pipeline = params.pipeline;
      config.max_br = params.max_br;
      config.srt_latency = params.srt_latency;
      config.srt_streamid = params.srt_streamid;
      config.srtla_addr = params.srtla_addr;
      config.srtla_port = params.srtla_port;

      saveConfig();

      broadcastMsgExcept(conn, 'config', config);
      
      callback(pipeline);
    } else {
      startError(conn, "failed to resolve SRTLA addr " + params.srtla_addr, senderId);
    }
  });
}


/* Streaming status */
let isStreaming = false;
function updateStatus(status) {
  isStreaming = status;
  broadcastMsg('status', {is_streaming: isStreaming});
}

function genSrtlaIpList() {
  let list = "";
  let count = 0;

  for (i in netif) {
    if (netif[i].enabled) {
      list += netif[i].ip + "\n";
      count++;
    }
  }
  fs.writeFileSync(setup.ips_file, list);

  return count;
}

function updateSrtlaIps() {
  genSrtlaIpList();
  spawnSync("killall", ['-HUP', "srtla_send"], { detached: true});
}

function spawnStreamingLoop(command, args, cooldown = 100) {
  if (!isStreaming) return;

  const process = spawn(command, args, { stdio: 'inherit' });
  process.on('exit', function(code) {
    setTimeout(function() {
      spawnStreamingLoop(command, args, cooldown);
    }, cooldown);
  })
}

function start(conn, params) {
  if (isStreaming || isUpdating()) {
    sendStatus(conn);
    return;
  }

  const senderId = conn.senderId;
  updateConfig(conn, params, function(pipeline) {
    if (genSrtlaIpList() < 1) {
      startError(conn, "Failed to start, no available network connections", senderId);
      return;
    }
    isStreaming = true;

    spawnStreamingLoop(srtlaSendExec, [
                         9000,
                         config.srtla_addr,
                         config.srtla_port,
                         setup.ips_file
                       ]);

    const belacoderArgs = [
                            pipeline,
                            '127.0.0.1',
                            '9000',
                            '-d', config.delay,
                            '-b', setup.bitrate_file,
                            '-l', config.srt_latency,
                          ];
    if (config.srt_streamid != '') {
      belacoderArgs.push('-s');
      belacoderArgs.push(config.srt_streamid);
    }
    spawnStreamingLoop(belacoderExec, belacoderArgs, 2000);

    updateStatus(true);
  });
}

function stop() {
  updateStatus(false);
  spawnSync("killall", ["srtla_send"], {detached: true});
  spawnSync("killall", ["belacoder"], {detached: true});
}
stop(); // make sure we didn't inherit an orphan runner process


/* Misc commands */
function command(conn, cmd) {
  if (isStreaming || isUpdating()) {
    sendStatus(conn);
    return;
  }

  switch(cmd) {
    case 'poweroff':
      spawnSync("poweroff", {detached: true});
      break;
    case 'reboot':
      spawnSync("reboot", {detached: true});
      break;
    case 'update':
      doSoftwareUpdate();
      break;
    case 'start_ssh':
    case 'stop_ssh':
      startStopSsh(conn, cmd);
      break;
    case 'reset_ssh_pass':
      resetSshPassword(conn);
      break;
  }
}

function handleConfig(conn, msg, isRemote) {
  // setPassword does its own authentication
  for (const type in msg) {
    switch(type) {
      case 'password':
        setPassword(conn, msg[type], isRemote);
        break;
    }
  }

  if (!conn.isAuthed) return;

  for (const type in msg) {
    switch(type) {
      case 'remote_key':
        setRemoteKey(msg[type]);
        break;
    }
  }
}


/* Software updates */
let availableUpdates = setup.apt_update_enabled ? null : false;
let softUpdateStatus = null;
let lastAptUpdate;

function isUpdating() {
  return (softUpdateStatus != null);
}

function parseUpgradePackageCount(text) {
  try {
    const upgradedCount = parseInt(text.match(/(\d+) upgraded/)[1]);
    const newlyInstalledCount = parseInt(text.match(/, (\d+) newly installed/)[1]);
    const upgradeCount = upgradedCount + newlyInstalledCount;
    return upgradeCount;
  } catch(err) {
    return undefined;
  }
}

function parseUpgradeDownloadSize(text) {
  try {
    let downloadSize = text.split('Need to get ')[1];
    downloadSize = downloadSize.split(/\/|( of archives)/)[0];
    return downloadSize;
  } catch(err) {
    return undefined;
  }
}

function getSoftwareUpdateSize() {
  if (isStreaming || isUpdating()) return;

  exec("apt-get dist-upgrade --assume-no", function(err, stdout, stderr) {
    console.log(stdout);
    console.log(stderr);

    /*
    // Currently unused, may do some filtering in the future
    let packageList = stdout.split("The following packages will be upgraded:\n")[1];
    packageList = packageList.split(/\n\d+/)[0];
    packageList = packageList.replace(/[\n ]+/g, ' ');
    packageList = packageList.trim();
    */

    const upgradeCount = parseUpgradePackageCount(stdout);
    let downloadSize;
    if (upgradeCount > 0) {
      downloadSize = parseUpgradeDownloadSize(stdout);
    }
    availableUpdates = {package_count: upgradeCount, download_size: downloadSize};
    broadcastMsg('status', {available_updates: availableUpdates});
  });
}

function checkForSoftwareUpdates() {
  if (isStreaming || isUpdating()) return;

  if (lastAptUpdate && (lastAptUpdate + oneDay) < getms()) return;

  exec("apt-get update --allow-releaseinfo-change", function(err, stdout, stderr) {
    console.log(`apt-get update: ${(err === null) ? 'success' : 'error'}`);
    console.log(stdout);
    console.log(stderr);

    if (err === null) {
      lastAptUpdate = getms();
      getSoftwareUpdateSize();
    } else {
      setTimeout(checkForSoftwareUpdates, oneHour);
    }
  });
}
if (setup.apt_update_enabled) {
  checkForSoftwareUpdates();
  setInterval(checkForSoftwareUpdates, oneHour);
}

function doSoftwareUpdate() {
  if (!setup.apt_update_enabled || isStreaming || isUpdating()) return;

  let aptLog = '';
  let aptErr = '';
  softUpdateStatus = {downloading: 0, unpacking: 0, setting_up: 0, total: 0};

  broadcastMsg('status', {updating: softUpdateStatus});

  const args = "-y -o \"Dpkg::Options::=--force-confdef\" -o \"Dpkg::Options::=--force-confold\" dist-upgrade".split(' ');
  const aptUpgrade = spawn("apt-get", args);

  aptUpgrade.stdout.on('data', function(data) {
    let sendUpdate = false;

    data = data.toString('utf8');
    aptLog += data;
    if (softUpdateStatus.total == 0) {
      let count = parseUpgradePackageCount(data);
      if (count !== undefined) {
        softUpdateStatus.total = count;
        sendUpdate = true;
      }
    }

    if (softUpdateStatus.downloading != softUpdateStatus.total) {
      const getMatch = data.match(/Get:(\d+)/);
      if (getMatch) {
        const i = parseInt(getMatch[1]);
        if (i > softUpdateStatus.downloading) {
          softUpdateStatus.downloading = Math.min(i, softUpdateStatus.total);
          sendUpdate = true;
        }
      }
    }

    const unpacking = data.match(/Unpacking /g);
    if (unpacking) {
      softUpdateStatus.downloading = softUpdateStatus.total;
      softUpdateStatus.unpacking += unpacking.length;
      softUpdateStatus.unpacking = Math.min(softUpdateStatus.unpacking, softUpdateStatus.total);
      sendUpdate = true;
    }

    const setting_up = data.match(/Setting up /g);
    if (setting_up) {
      softUpdateStatus.setting_up += setting_up.length;
      softUpdateStatus.setting_up = Math.min(softUpdateStatus.setting_up, softUpdateStatus.total);
      sendUpdate = true;
    }

    if (sendUpdate) {
      broadcastMsg('status', {updating: softUpdateStatus});
    }
  });

  aptUpgrade.stderr.on('data', function(data) {
    aptErr += data;
  });

  aptUpgrade.on('close', function(code) {
    softUpdateStatus.result = (code == 0) ? code : aptErr;
    broadcastMsg('status', {updating: softUpdateStatus});

    softUpdateStatus = null;
    console.log(aptLog);
    console.log(aptErr);

    if (code == 0) process.exit(0);
  });
}


/* SSH control */
let sshStatus;
function handleSshStatus(s) {
  if (s.user !== undefined && s.active !== undefined && s.user_pass !== undefined) {
    if (!sshStatus ||
        s.user != sshStatus.user ||
        s.active != sshStatus.active ||
        s.user_pass != sshStatus.user_pass) {
      sshStatus = s;
      broadcastMsg('status', {ssh: sshStatus});
    }
  }
}

function getSshUserHash(callback) {
  if (!setup.ssh_user) return;

  const cmd = `grep "^${setup.ssh_user}:" /etc/shadow`;
  exec(cmd, function(err, stdout, stderr) {
    if (err === null && stdout.length) {
      callback(stdout);
    } else {
      console.log(`Error getting the password hash for ${setup.ssh_user}: ${err}`);
    }
  });
}

function getSshStatus(conn) {
  if (!setup.ssh_user) return undefined;

  let s = {};
  s.user = setup.ssh_user;

  // Check is the SSH server is running
  exec('systemctl is-active ssh', function(err, stdout, stderr) {
    if (err === null) {
      s.active = true;
    } else {
      if (stdout == "inactive\n") {
        s.active = false;
      } else {
        console.log('Error running systemctl is-active ssh: ' + err.message);
        return;
      }
    }

    handleSshStatus(s);
  });

  // Check if the user's password has been changed
  getSshUserHash(function(hash) {
    s.user_pass = (hash != sshPasswordHash);
    handleSshStatus(s);
  });

  // If an immediate result is expected, send the cached status
  return sshStatus;
}
getSshStatus();

function startStopSsh(conn, cmd) {
  if (!setup.ssh_user) return;

  switch(cmd) {
    case 'start_ssh':
      if (config.ssh_pass === undefined) {
        resetSshPassword(conn);
      }
    case 'stop_ssh':
      const action = cmd.split('_')[0];
      spawnSync('systemctl', [action, 'ssh'], {detached: true});
      getSshStatus();
      break;
  }
}

function resetSshPassword(conn) {
  if (!setup.ssh_user) return;

  const password = crypto.randomBytes(24).toString('base64').
                   replace(/\+|\/|=/g, '').substring(0,20);
  const cmd = `printf "${password}\n${password}" | passwd ${setup.ssh_user}`;
  exec(cmd, function(err, stdout, stderr) {
    if (err) {
      notificationSend(conn, "ssh_pass_reset", "error",
                       `Failed to reset the SSH password for ${setup.ssh_user}`, 10);
      return;
    }
    getSshUserHash(function(hash) {
      config.ssh_pass = password;
      sshPasswordHash = hash;
      saveConfig();
      broadcastMsg('config', config);
      getSshStatus();
    });
  });
}

/* Authentication */
function setPassword(conn, password, isRemote) {
  if (conn.isAuthed || (!isRemote && !config.password_hash)) {
    const minLen = 8;
    if (password.length < minLen) {
      notificationSend(conn, "belaui_pass_length", "error",
                       `Minimum password length: ${minLen} characters`, 10);
      return;
    }
    config.password_hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    delete config.password;
    saveConfig();
  }
}

function genAuthToken(isPersistent) {
  const token = crypto.randomBytes(32).toString('base64');
  if (isPersistent) {
    persistentTokens[token] = true;
    savePersistentTokens();
  } else {
    tempTokens[token] = true;
  }
  return token;
}

function sendStatus(conn) {
  conn.send(buildMsg('status', {is_streaming: isStreaming,
                                available_updates: availableUpdates,
                                updating: softUpdateStatus,
                                ssh: getSshStatus(conn),
                                wifi: wifiBuildMsg()}));
}

function sendInitialStatus(conn) {
  conn.send(buildMsg('config', config));
  conn.send(buildMsg('pipelines', getPipelineList()));
  sendStatus(conn);
  conn.send(buildMsg('netif', netif));
  conn.send(buildMsg('sensors', sensors));
  conn.send(buildMsg('revisions', revisions));
  notificationSendPersistent(conn);
}

function connAuth(conn, sendToken) {
  conn.isAuthed = true;
  let result = {success: true};
  if (sendToken != undefined) {
    result['auth_token'] = sendToken;
  }
  conn.send(buildMsg('auth', result));
  sendInitialStatus(conn);
}

function tryAuth(conn, msg) {
  if (!config.password_hash) {
    conn.send(buildMsg('auth', {success: false}));
    return;
  }

  if (typeof(msg.password) == 'string') {
    bcrypt.compare(msg.password, config.password_hash, function(err, match) {
      if (match == true && err == undefined) {
        conn.authToken = genAuthToken(msg.persistent_token);
        connAuth(conn, conn.authToken);
      } else {
        notificationSend(conn, "auth", "error", "Invalid password");
      }
    });
  } else if (typeof(msg.token) == 'string') {
    if (tempTokens[msg.token] || persistentTokens[msg.token]) {
      connAuth(conn);
      conn.authToken = msg.token;
    } else {
      conn.send(buildMsg('auth', {success: false}));
    }
  }
}


function handleMessage(conn, msg, isRemote = false) {
  if (!isRemote) {
    for (const type in msg) {
      switch(type) {
        case 'auth':
          tryAuth(conn, msg[type]);
          break;
      }
    }
  }

  for (const type in msg) {
    switch(type) {
      case 'config':
        handleConfig(conn, msg[type], isRemote);
        break;
    }
  }

  if (!conn.isAuthed) return;

  for (const type in msg) {
    switch(type) {
      case 'keepalive':
        // NOP - conn.lastActive is updated when receiving any valid message
        break;
      case 'start':
        start(conn, msg[type]);
        break;
      case 'stop':
        stop();
        break;
      case 'bitrate':
        if (isStreaming) {
          const br = setBitrate(msg[type]);
          if (br != null) {
            broadcastMsgExcept(conn, 'bitrate', {max_br: br});
          }
        }
        break;
      case 'command':
        command(conn, msg[type]);
        break;
      case 'netif':
        handleNetif(conn, msg[type]);
        break;
      case 'wifi':
        handleWifi(conn, msg[type]);
        break;
      case 'logout':
        if (conn.authToken) {
          delete tempTokens[conn.authToken];
          if (persistentTokens[conn.authToken]) {
            delete persistentTokens[conn.authToken];
            savePersistentTokens();
          }
        }
        delete conn.isAuthed;
        delete conn.authToken;

        break;
    }
  }

  conn.lastActive = getms();
}

server.listen(process.env.PORT || 80);
