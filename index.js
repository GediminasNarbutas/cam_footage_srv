const net = require('net');
const commandLineArgs = require('command-line-args');
const tls = require('tls');
const fs = require('fs');
const ftpu = require('./file_transfer_protocol_utils.js');
const cliProgress = require('cli-progress');
const _colors = require('colors');

process.setMaxListeners(12);

console.clear();
ftpu.LogString("Camera Transfer Server (Copyright © 2022, Teltonika), version 0.1.2");
console.log("Camera Transfer Server (Copyright © 2022, \x1b[34mTeltonika\x1b[0m), version 0.1.2");

const optionDefinitions = [
    { name: 'help', alias: 'h', type: Boolean },
    { name: 'tls', alias: 't', type: Boolean },
    { name: 'port', alias: 'p', type: Number },
    { name: 'cert', alias: 'c' },
    { name: 'key', alias: 'k' },
    { name: 'cam', alias: 'r', type: Number },
    { name: 'meta', alias: 'm', type: String },
]
const args = commandLineArgs(optionDefinitions);

if (args.help == true) {
    console.log(`usage: cts-win.exe [-h/--help] [--tls] [-p/--port <port>] [-c/--cert <path>] [-k/--key <key>] [-r/--cam <camera id>] [-m/--meta <meta id>]
    
    Argument usage:
       --help, -h        Bring up help menu
       --tls             Enables TLS mode (if this parameter is passed, then cert and key must be provided, otherwise the server works in non-TLS mode)
       --port, -p        Port to listen to
       --cert, -c        Path to root certificate file
       --key, -k         Path to private key file
       --cam, -r         Camera type (0 - Auto, 1 - ADAS, 2 - DualCam)
       --meta, -m        Metadata (0 - No metadata, 1 - Before file download)`
       );
    process.exit();
}

/* Check arguments for port */
let port = 0;
if (args.port > 0) {
    port = args.port;
} else {
    ftpu.LogString("[ERROR] Port provided incorrectly / not provided in arguments!");
    console.log("[\x1b[31mERROR\x1b[0m] Port provided incorrectly / not provided in arguments!");
    process.exit();
}

const CAMERA_TYPE = {
    AUTO: 0,
    ADAS: 1,
    DUALCAM: 2,
}

const METADATA_TYPE = {
    NO_METADATA: 0,
    AT_START: 1,
    AT_END: 2,
}

const ReceiveState = {
    WAIT_FOR_CMD: 0,
    INIT: 1,
    RECEIVE_DATA: 2,
    FINISH_RECEIVING: 3,
    REPEAT_PACKET: 4,
    SEND_METADATA_REQUEST: 5,
    SEND_FILEPATH: 6,
    LOOK_FOR_FILES: 7,
    END: 8,
};

let camera = 0;
if (typeof(args.cam) != "undefined") {
    if (args.cam >= 0 && args.cam <= 2) {
        if (args.cam == CAMERA_TYPE.AUTO) {
            console.log("[\x1b[34mSERVER\x1b[0m] Chosen auto camera type detection");
        }
        if (args.cam == CAMERA_TYPE.ADAS) {
            console.log("[\x1b[34mSERVER\x1b[0m] Chosen ADAS camera type");
        }
        if (args.cam == CAMERA_TYPE.DUALCAM) {
            console.log("[\x1b[34mSERVER\x1b[0m] Chosen DualCam camera type");
        }
        camera = args.cam;
    } else {
        console.log("[\x1b[31mERROR\x1b[0m] Camera type provided incorrectly! " + args.cam);
        process.exit();
    }
} else {
    console.log("[\x1b[34mSERVER\x1b[0m] No camera type chosen. Defaulting to auto camera type detection");
}

let metadata_type = 0;
if (typeof(args.meta) != "undefined") {
    if (args.meta == 0 || args.meta == 1) {
        if (args.meta == 0) {
            metadata_type = METADATA_TYPE.NO_METADATA;
            console.log("[\x1b[34mSERVER\x1b[0m] No metadata requests will be made");
        }
        if (args.meta == 1) {
            metadata_type = METADATA_TYPE.AT_START;
            console.log("[\x1b[34mSERVER\x1b[0m] Metadata will be requested at the start of the file transfer");
        }
    } else {
        console.log("[\x1b[31mERROR\x1b[0m] Metadata request parameter provided incorrectly!");
        process.exit();
    }
} else {
    console.log("[\x1b[34mSERVER\x1b[0m] No metadata requests will be made");
}

let server;
if (args.tls && typeof args.key !== "undefined" && typeof args.cert !== "undefined") {
    ftpu.LogString('[SERVER] Starting TLS mode');
    console.log('[\x1b[34mSERVER\x1b[0m] Starting TLS mode');
    var options = {
        key: fs.readFileSync(args.key),
        cert: fs.readFileSync(args.cert),
    };
    server = tls.createServer(options, handleConnection);
} else {
    ftpu.LogString('[SERVER] Starting REGULAR mode');
    console.log('[\x1b[34mSERVER\x1b[0m] Starting REGULAR mode');
    var options;
    server = net.createServer(options, handleConnection);
}

/* Start listening to port */
server.listen(port, function () {
    ftpu.LogString('[SERVER] listening to ' + server.address()["port"] + ' port');
    console.log('[\x1b[34mSERVER\x1b[0m] listening to ' + server.address()["port"] + ' port');
});

/* Network handler */
const buffer_size = 3000000;

function handleConnection(conn) {
    const bar1 = new cliProgress.SingleBar({
        format: '[\x1b[34mSERVER\x1b[0m] Download Progress |' + _colors.blue('{bar}') + '| {percentage}% || {value}/{total} Chunks || ETA: {eta} seconds',
        barsize: 40,
        hideCursor: true
    }, cliProgress.Presets.shades_grey);

    let tcp_buff = Buffer.alloc(0);
    let remoteAddress = conn.remoteAddress + ':' + conn.remotePort;
    let stateMachine = ReceiveState.INIT;
    let wait_more_data = false;
    let cmd_size = 0;
    let cmd_id = 0;
    
    let deviceStatus = new ftpu.DeviceDescriptor();
    let metadata = new ftpu.MetaDataDescriptor();
    ftpu.LogString('[SERVER] client connected: ' + remoteAddress);
    console.log('[\x1b[34mSERVER\x1b[0m] client connected: ' + remoteAddress);

    conn.on('data', onConnData);
    conn.once('close', onConnClose);
    conn.on('error', onConnError);
    conn.on('timeout', onConnTimeout);

    function onConnData(data) {
        if (data.length > buffer_size) {
            ftpu.LogString("[ERROR] Too much data: " + data.length + " > " + buffer_size);
            console.log("[\x1b[31mERROR\x1b[0m] Too much data: " + data.length + " > " + buffer_size);
            return;
        }
        tcp_buff = Buffer.concat([tcp_buff, data]);
        ftpu.LogString("[INFO] Data from: " + remoteAddress + "[" + tcp_buff.toString('hex') + "]");
        //console.log("[INFO] Data from: " + remoteAddress + "[" + tcp_buff.toString('hex') + "]");
        
        if (wait_more_data) {
            if (tcp_buff.length < cmd_size) {
                ftpu.LogString("[ERROR] Wrong buffer size: " + cmd_size + " > " + tcp_buff.length);
                //console.log("[\x1b[31mERROR\x1b[0m] Wrong buffer size: " + cmd_size + " > " + tcp_buff.length);
                //tcp_buff = Buffer.alloc(0);
                return;
            } else {
                ftpu.LogString("[INFO] Got all data. CMD size: " + cmd_size + ", Buffer size: " + tcp_buff.length);
                //console.log("[INFO] Got all data. CMD size: " + cmd_size + ", Buffer size: " + tcp_buff.length);
            }
            wait_more_data = false;
        } else {
            if (tcp_buff.length < 4) {
                ftpu.LogString("[ERROR] Not enough bytes for a valid command: " + tcp_buff.length + " < 4");
                console.log("[\x1b[31mERROR\x1b[0m] Not enough bytes for a valid command: " + tcp_buff.length + " < 4");
                //tcp_buff = Buffer.alloc(0);
                return;
            }
            cmd_id = ftpu.ParseCmd(tcp_buff);
            if (ftpu.IsCmdValid(cmd_id)) {
                ftpu.LogString("[INFO] Received CMD ID: " + cmd_id);
                //console.log("[INFO] Received CMD ID: " + cmd_id);
            } else {
                ftpu.LogString("[ERROR] Invalid CMD ID: " + cmd_id);
                console.log("[\x1b[31mERROR\x1b[0m] Invalid CMD ID: " + cmd_id);
                //tcp_buff = Buffer.alloc(0);
                return;
            }
            if (ftpu.CmdHasLengthField(cmd_id)) {
                cmd_size = tcp_buff.readUInt16BE(2) + 4;
            } else {
                cmd_size = ftpu.GetExpectedCommandLength(cmd_id);
            }
            if (tcp_buff.length < cmd_size) {
                ftpu.LogString("[INFO] Waiting for more data... CMD size: " + cmd_size + ", Buffer size: " + tcp_buff.length);
                //console.log("[INFO] Waiting for more data... CMD size: " + cmd_size + ", Buffer size: " + tcp_buff.length);
                wait_more_data = true;
            }
        }
        if (!wait_more_data) {
            while (1) {
                ftpu.LogString("[INFO] Parsing: " + tcp_buff.toString('hex'));
                //console.log("[INFO] Parsing: " + tcp_buff.toString('hex'));
                stateMachine = ftpu.StateMachine(stateMachine, conn, cmd_id, tcp_buff, deviceStatus, metadata, bar1, camera, metadata_type);
                tcp_buff = tcp_buff.slice(cmd_size, tcp_buff.length);
                if (tcp_buff.length == 0) {
                    ftpu.LogString("[INFO] Buffer is empty");
                    //console.log("[INFO] Buffer is empty");
                    break;
                }
                ftpu.LogString("[INFO] Remaining bytes in buffer: " + tcp_buff.length);
                //console.log("[INFO] Remaining bytes in buffer: " + tcp_buff.length);
                if (tcp_buff.length < 4) {
                    ftpu.LogString("[ERROR] Not enough bytes for a valid command: " + tcp_buff.length + " < 4");
                    console.log("[\x1b[31mERROR\x1b[0m] Not enough bytes for a valid command: " + tcp_buff.length + " < 4");
                    //tcp_buff = Buffer.alloc(0);
                    break;
                }
                cmd_id = ftpu.ParseCmd(tcp_buff);
                if (ftpu.IsCmdValid(cmd_id)) {
                    ftpu.LogString("[INFO] Received CMD ID: " + cmd_id);
                    //console.log("[INFO] Received CMD ID: " + cmd_id);
                } else {
                    ftpu.LogString("[ERROR] Invalid CMD ID: " + cmd_id);
                    console.log("[\x1b[31mERROR\x1b[0m] Invalid CMD ID: " + cmd_id);
                    //tcp_buff = Buffer.alloc(0);
                    break;
                }
                if (ftpu.CmdHasLengthField(cmd_id)) {
                    cmd_size = tcp_buff.readUInt16BE(2) + 4;
                } else {
                    cmd_size = ftpu.GetExpectedCommandLength(cmd_id);
                }
                if (tcp_buff.length < cmd_size) {
                    ftpu.LogString("[INFO] Waiting for more data... CMD size: " + cmd_size + ", Buffer size: " + tcp_buff.length);
                    //console.log("[INFO] Waiting for more data... CMD size: " + cmd_size + ", Buffer size: " + tcp_buff.length);
                    wait_more_data = true;
                    break;
                }
            }
        }
    }

    function onConnClose() {
        ftpu.LogString('[SERVER] connection from ' + remoteAddress + ' closed');
        console.log('[\x1b[34mSERVER\x1b[0m] connection from ' + remoteAddress + ' closed');
    }

    function onConnError(err) {
        ftpu.LogString('[SERVER] connection ' + remoteAddress + ' error: ' + err.message);
        console.log('[\x1b[34mSERVER\x1b[0m] connection ' + remoteAddress + ' error: ' + err.message);
    }

    function onConnTimeout() {
        ftpu.LogString('[SERVER] connection from ' + remoteAddress + ' timeouted');
        console.log('[\x1b[34mSERVER\x1b[0m] connection from ' + remoteAddress + ' timeouted');
    }
}
