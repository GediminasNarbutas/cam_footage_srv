const fs = require('fs');
const process = require('process');
const winston = require('winston');
const { exec } = require("child_process");
const cliProgress = require('cli-progress');
const _colors = require('colors');

/* Constants */
const ReceiveState = {
    WAIT_FOR_CMD: 0,
    INIT: 1,
    RECEIVE_DATA: 2,
    FINISH_RECEIVING: 3,
    REPEAT_PACKET: 4,
    SEND_METADATA_REQUEST: 5,
    SEND_FILEPATH: 6,
    LOOK_FOR_FILES: 7,
    SEND_COMPLETE: 8,
    SEND_END: 9,
    END: 10,
};

const file_path = {
    DUALCAM_PHOTO_FRONT: "%photof",
    DUALCAM_PHOTO_REAR: "%photor",
    DUALCAM_VIDEO_FRONT: "%videof",
    DUALCAM_VIDEO_REAR: "%videor",
};

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

const CMD = {
    INIT: 0,
    START: 1,
    SYNC: 3,
    DATA: 4,
    METADATA: 11,
    FILEPATH: 13,
}

/* Create logger */
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    defaultMeta: { service: 'user-service' },
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
    ],
});

function LogStringLocal(string) {
    logger.log('info', string);
};

exports.LogString = LogStringLocal;

function clearLogLocal() {
    logger.clear();
};

exports.clearLog = clearLogLocal;

//file_buff = Buffer.alloc(0);

function Device() {
    this.deviceDirectory = "";
    this.filename = "";
    this.actual_crc = 0;
    this.received_packages = 0;
    this.total_packages = 0;
    this.extension_to_use = "";
    this.query_file = 0;
    this.file_buff = Buffer.alloc(0);
    this.camera = CAMERA_TYPE.AUTO;
    this.metadata_type = METADATA_TYPE.NO_METADATA;
}

exports.DeviceDescriptor = Device;
Device.prototype.setDeviceDirectory = function (directory) {
    this.deviceDirectory = directory;
}

Device.prototype.getDeviceDirectory = function () {
    return this.deviceDirectory;
}

Device.prototype.setCurrentFilename = function (filename) {
    this.filename = filename;
}

Device.prototype.getCurrentFilename = function () {
    return this.filename;
}

Device.prototype.setLastCRC = function (crc) {
    this.actual_crc = crc;
}

Device.prototype.getLastCRC = function () {
    return this.actual_crc;
}

Device.prototype.incrementReceivedPackageCnt = function () {
    this.received_packages++;
}

Device.prototype.getReceivedPackageCnt = function () {
    return this.received_packages;
}

Device.prototype.setReceivedPackageCnt = function (package_cnt) {
    this.received_packages = package_cnt;
}

Device.prototype.resetReceivedPackageCnt = function () {
    this.received_packages = 0;
}

Device.prototype.setTotalPackages = function (pkg) {
    this.total_packages = pkg;
}

Device.prototype.getTotalPackages = function () {
    return this.total_packages;
}

Device.prototype.getExtension = function () {
    return this.extension_to_use;
}

Device.prototype.setExtension = function (extension) {
    this.extension_to_use = extension;
}

Device.prototype.setFileToDL = function (file) {
    this.query_file = file;
}

Device.prototype.getFileToDL = function (file) {
    return this.query_file;
}

Device.prototype.getFileBuffer = function () {
    return this.file_buff;
}

Device.prototype.addToBuffer = function (data) {
    this.file_buff = Buffer.concat([this.file_buff, data])
}

Device.prototype.clearBuffer = function () {
    this.file_buff = Buffer.alloc(0);
}

Device.prototype.setCameraType = function (type) {
    this.camera = type;
}

Device.prototype.getCameraType = function () {
    return this.camera;
}

let TRIGGER_SOURCE = {
    0: "SERVER REQUEST",
    1: "DIN1",
    2: "DIN2",
    3: "CRASH",
    4: "TOWING",
    5: "IDLING",
    6: "GEOFENCE",
    7: "UNPLUG",
    8: "GREEN DRIVING",
    9: "PERIODIC",
}

let FILE_TYPE = {
    4:  "FRONT PHOTO",
    8:  "REAR PHOTO",
    16: "FRONT VIDEO",
    32: "REAR VIDEO",
}

function MetaData() {
    this.command_version = "";   //1 byte
    this.file_type = "";         //1 byte
    this.timestamp = "";         //8 bytes (uint, seconds)
    this.trigger_source = "";    //1 byte
    this.length = "";            //2 bytes
    this.framerate = "";         //1 byte
    this.timezone = "";          //2 bytes (int, minutes)
    this.latitude = "";          //8 bytes
    this.longitude = "";         //8 bytes
}

exports.MetaDataDescriptor = MetaData;

MetaData.prototype.reset = function () {
    this.command_version = "";
    this.file_type = "";
    this.timestamp = "";
    this.trigger_source = "";
    this.length = "";
    this.framerate = "";
    this.timezone = "";
    this.latitude = "";
    this.longitude = "";
}

MetaData.prototype.getString = function () {
    let string = "Cmd version: \t" + this.command_version + '\n';
    string +=    "File type: \t" + this.file_type + '\n';
    string +=    "Time (UTC+0): \t" + this.timestamp + '\n';
    string +=    "Trigger: \t" + this.trigger_source + '\n';
    string +=    "Length (s): \t" + this.length + '\n';
    string +=    "Framerate: \t" + this.framerate + '\n';
    string +=    "Timezone (m): \t" + this.timezone + '\n';
    string +=    "Latitude: \t" + this.latitude + '\n';
    string +=    "Longitude: \t" + this.longitude + '\n';
    return string;
}

MetaData.prototype.setCommandVersion = function (command_version) {
    this.command_version = command_version.readUInt8(0).toString(10);
}

MetaData.prototype.getCommandVersion = function () {
    return this.command_version;
}

MetaData.prototype.setFileType = function (file_type) {
    this.file_type = FILE_TYPE[file_type.readUInt8(0)] + " (" + file_type.readUInt8(0).toString(10) + ")";
}

MetaData.prototype.getFileType = function () {
    return this.file_type;
}

MetaData.prototype.setTimestamp = function (timestamp) {
    var date = new Date( Number(timestamp.readBigUInt64BE(0)));
    this.timestamp = date.toISOString().replace(/[TZ]/g, ' ') + "(" + timestamp.readBigUInt64BE(0).toString(10) + ")";
}

MetaData.prototype.getTimestamp = function () {
    return this.timestamp;
}

MetaData.prototype.setTriggerSource = function (trigger_source) {
    this.trigger_source = TRIGGER_SOURCE[trigger_source.readUInt8(0)] + " (" + trigger_source.readUInt8(0).toString(10) + ")";
}

MetaData.prototype.getTriggerSource = function () {
    return this.trigger_source;
}

MetaData.prototype.setLength = function (length) {
    this.length = length.readUInt16BE(0).toString(10);
}

MetaData.prototype.getLength = function () {
    return this.length;
}

MetaData.prototype.setFramerate = function (framerate) {
    this.framerate = framerate.readUInt8(0).toString(10);
}

MetaData.prototype.getFramerate = function () {
    return this.framerate;
}

MetaData.prototype.setTimezone = function (timezone) {
    this.timezone = timezone.readInt16BE(0).toString(10);
}

MetaData.prototype.getTimezone = function () {
    return this.timezone;
}

MetaData.prototype.setLatitude = function (latitude) {
    this.latitude = latitude.readBigUInt64BE(0).toString(10);
}

MetaData.prototype.getLatitude = function () {
    return this.latitude;
}

MetaData.prototype.setLongitude = function (longitude) {
    this.longitude = longitude.readBigUInt64BE(0).toString(10);
}

MetaData.prototype.getLongitude = function () {
    return this.longitude;
}

function crc16_generic(init_value, poly, data) {
    let RetVal = init_value;
    let offset;

    for (offset = 0; offset < data.length; offset++) {
        let bit;
        RetVal ^= data[offset];
        for (bit = 0; bit < 8; bit++) {
            let carry = RetVal & 0x01;
            RetVal >>= 0x01;
            if (carry) {
                RetVal ^= poly;
            }
        }
    }
    return RetVal;
}

exports.ParseCmd = function (a) {
    return a.readUInt16BE(0);
};

exports.CmdHasLengthField = function getCmdLengthOpt(cmd_id) {
    if (cmd_id == 4 || cmd_id == 5 || cmd_id == 13 || cmd_id == 11) {
        return true;
    }
    return false;
};

exports.IsCmdValid = function doesCmdExist(cmd_id) {
    if (cmd_id < 15) {
        return true;
    } else {
        return false;
    }
};

exports.GetExpectedCommandLength = function (cmd) {
    let return_value = 0;
    switch (cmd) {
        case 0:
            return_value = 16;
            break;
        case 1:
            return_value = 10;
            break;
        case 3:
            return_value = 8;
            break;
    }
    return return_value;
};

function ParseFilePath(a) {
    let path = a.toString().substring(4);
    return path;
};

function ConvertVideoFile(directory, filename, extension) {
    let form_command = "ffmpeg -hide_banner -loglevel quiet -r 25 -i \"" + directory + "\\" + filename + extension + "\" -ss 00:00:0.9 -c:a copy -c:v libx264 \"" + directory + "\\" + filename + ".mp4\"";
    exec(form_command, (error, stdout, stderr) => {
        if (error) {
            console.log(`error: ${error.message}`);
            return;
        }
        if (stderr) {
            console.log(`stderr: ${stderr}`);
            return;
        }
    });
}

exports.StateMachine = function (current_state, conn, cmd, d, device_status, metadata, bar1, camera, metadata_type) {
    let file_available = false;

    switch (cmd) {
        case CMD.START: {
            switch (device_status.getCameraType()) {
                case CAMERA_TYPE.DUALCAM:
                    device_status.setTotalPackages(d.readUInt32BE(4));
                    // console.log("[INFO] Camera: DUALCAM");
                    break;
                case CAMERA_TYPE.ADAS:
                    device_status.setTotalPackages(Math.ceil((d.readUInt32BE(4) / 1024)));
                    // console.log("[INFO] Camera: ADAS");
                    break;
            }
            if (device_status.getTotalPackages() == 0) {
                LogStringLocal("[INFO] No packages are left for this file");
                console.log("[INFO] No packages are left for this file");
                finish_comms = true;
            } else {
                LogStringLocal("[INFO] Total packages incoming for this file: " + device_status.getTotalPackages());
                console.log("[INFO] Total packages incoming for this file: " + device_status.getTotalPackages());
                LogStringLocal("[INFO] Sending resume command");
                //console.log("[INFO] Sending resume command");
                const query = Buffer.from([0, 2, 0, 4, 0, 0, 0, 0]);
                conn.write(query);
                LogStringLocal('[SERVER.SOCKET.TX]: ' + query.toString('hex'));
                current_state = ReceiveState.WAIT_FOR_CMD;
                let total_pkg = device_status.getTotalPackages();
                bar1.start(total_pkg, 0);
            }
            break;
        }

        case CMD.SYNC: {
            LogStringLocal("[INFO] Sync has been received!");
            //console.log("[INFO] Sync has been received!");
            //device_status.setReceivedPackageCnt(d.readUInt32BE(4));
            current_state = ReceiveState.WAIT_FOR_CMD;
            break;
        }

        case CMD.DATA: {
            /* Read data length minus CRC */
            let data_len = d.readUInt16BE(2) - 2;
            /* Get raw file data */
            let raw_file = d.slice(4, 4 + data_len);
            /* Calculate CRC + add sum of last packet */
            let computed_crc = crc16_generic(device_status.getLastCRC(), 0x8408, d.slice(4, 4 + data_len));
            /* Read actual CRC in packet */
            let actual_crc = d.readUInt16BE(4 + data_len);
            /* Calculate CRC and display with actual */
            LogStringLocal("[INFO] CRC = Computed: " + computed_crc + ", Actual : " + actual_crc);
            //console.log("[INFO] CRC = Computed: " + computed_crc + ", Actual : " + actual_crc);

            if (computed_crc != actual_crc) {
                LogStringLocal("[ERROR] CRC mismatch!");
                console.log("[ERROR] CRC mismatch!");
                //device_status.setLastCRC(0);
                current_state = ReceiveState.REPEAT_PACKET;
            } else {
                device_status.incrementReceivedPackageCnt();
                LogStringLocal("[INFO] Package: " + device_status.getReceivedPackageCnt() + " / " + device_status.getTotalPackages());
                device_status.addToBuffer(raw_file);
                let rx_pkg_cnt = device_status.getReceivedPackageCnt();
                bar1.update(rx_pkg_cnt);
                // Save for calculating next packet's CRC
                device_status.setLastCRC(actual_crc);
            }

            if (device_status.getTotalPackages() == device_status.getReceivedPackageCnt()) {
                current_state = ReceiveState.FINISH_RECEIVING;
            }
            break;
        }

        case CMD.METADATA: {
            /* Read data length minus CRC */
            let data_len = d.readUInt16BE(2);
            /* Get raw file data */
            let raw_data = d.slice(4, 4 + data_len);
            LogStringLocal("[INFO] Got metadata: " + raw_data.toString('hex'));
            console.log("[INFO] Got metadata: " + raw_data.toString('hex'));

            metadata.reset();
            metadata.setCommandVersion(raw_data.slice(0, 1));   //1 byte
            metadata.setFileType(raw_data.slice(1, 2));         //1 byte
            metadata.setTimestamp(raw_data.slice(2, 10));       //8 bytes (uint, seconds)
            metadata.setTriggerSource(raw_data.slice(10, 11));  //1 byte
            metadata.setLength(raw_data.slice(11, 13));         //2 bytes
            metadata.setFramerate(raw_data.slice(13, 14));      //1 byte
            metadata.setTimezone(raw_data.slice(14, 16));       //2 bytes (int, minutes)
            metadata.setLatitude(raw_data.slice(16, 24));       //8 bytes
            metadata.setLongitude(raw_data.slice(24, 32));      //8 bytes

            fs.appendFile("./" + device_status.getDeviceDirectory() + '/' + device_status.getCurrentFilename() + ".txt", metadata.getString(), function (err) {
                temp_file_buff = Buffer.alloc(0);
                if (err) return LogStringLocal(err);
                LogStringLocal("[INFO] Metadata written to file " + device_status.getCurrentFilename() + " successfully");
                //console.log("[INFO] Metadata written to file " + device_status.getCurrentFilename() + " successfully");
            });

            if (metadata_type == METADATA_TYPE.AT_START) {
                current_state = ReceiveState.SEND_FILEPATH;
            }
            if (metadata_type == METADATA_TYPE.AT_END) {
                current_state = ReceiveState.LOOK_FOR_FILES;
            }
            break;
        }

        case CMD.FILEPATH: {
            let path = ParseFilePath(d);
            console.log("[INFO] Got ADAS file path: " + path);
            if (path.search("picture") > -1) {
                device_status.setExtension(".jpg");
            }
            if (path.search("video") > -1) {
                device_status.setExtension(".mp4");
            }
            device_status.setFileToDL(path);
            device_status.clearBuffer();
            device_status.setLastCRC(0);
            let query = Buffer.concat([Buffer.from([0, 8, 0, path.length]), Buffer.from(path)]);
            LogStringLocal('[SERVER.SOCKET.TX]: ' + query.toString('hex'));
            conn.write(query);
            current_state = ReceiveState.WAIT_FOR_CMD;
            break;
        }
    }

    if (current_state == ReceiveState.INIT) {
        //Create dir with device IMEI if doesn't exist
        if (!fs.existsSync('downloads')) {
            fs.mkdirSync('downloads');
        }
        let imei = d.readBigUInt64BE(4);
        device_status.setDeviceDirectory('downloads/' + imei.toString());
        if (!fs.existsSync(device_status.getDeviceDirectory())) {
            LogStringLocal("[INFO] Creating directory " + device_status.getDeviceDirectory());
            console.log("[INFO] Creating directory " + device_status.getDeviceDirectory());
            fs.mkdirSync(device_status.getDeviceDirectory());
        }
        // Read OPT byte to see what files are pending
        const opt1_byte = d.readUInt8(12);
        //console.log("[INFO] Option byte: " + opt1_byte);
        if ((camera == CAMERA_TYPE.ADAS) || (camera == CAMERA_TYPE.AUTO)) {
            if (opt1_byte & 0x02) {
                LogStringLocal("[INFO] ADAS file available! Sending file path request.");
                console.log("[INFO] ADAS file available! Sending file path request.");
                const query = Buffer.from([0, 12, 0, 2, 0, 0]);
                conn.write(query);
                device_status.setCameraType(CAMERA_TYPE.ADAS)
                current_state = ReceiveState.WAIT_FOR_CMD;
                file_available = true;
            }
        }
        if ((camera == CAMERA_TYPE.DUALCAM || camera == CAMERA_TYPE.AUTO) && file_available == false) {
            if (opt1_byte & 0x20) {
                LogStringLocal("[INFO] DualCam rear video available!");
                console.log("[INFO] DualCam rear video available!");
                device_status.setFileToDL(file_path.DUALCAM_VIDEO_REAR);
                device_status.setExtension(".h265");
                device_status.setCameraType(CAMERA_TYPE.DUALCAM);
                file_available = true;
            } else if (opt1_byte & 0x10) {
                LogStringLocal("[INFO] DualCam front video available!");
                console.log("[INFO] DualCam front video available!");
                device_status.setFileToDL(file_path.DUALCAM_VIDEO_FRONT);
                device_status.setExtension(".h265");
                device_status.setCameraType(CAMERA_TYPE.DUALCAM)
                file_available = true;
            } else if (opt1_byte & 0x08) {
                LogStringLocal("[INFO] DualCam rear photo available!");
                console.log("[INFO] DualCam rear photo available!");
                device_status.setFileToDL(file_path.DUALCAM_PHOTO_REAR);
                device_status.setExtension(".jpeg");
                device_status.setCameraType(CAMERA_TYPE.DUALCAM)
                file_available = true;
            } else if (opt1_byte & 0x04) {
                LogStringLocal("[INFO] DualCam front photo available!");
                console.log("[INFO] DualCam front photo available!");
                device_status.setFileToDL(file_path.DUALCAM_PHOTO_FRONT);
                device_status.setExtension(".jpeg");
                device_status.setCameraType(CAMERA_TYPE.DUALCAM)
                file_available = true;
            }
            if (file_available == true) {
                //console.log("[INFO] Got DualCam file path.");
                device_status.clearBuffer();
                device_status.setLastCRC(0);

                if (metadata_type == METADATA_TYPE.AT_START) {
                    current_state = ReceiveState.SEND_METADATA_REQUEST;
                }
                if (metadata_type == METADATA_TYPE.AT_END) {
                    current_state = ReceiveState.SEND_FILEPATH;
                }
                if (metadata_type == METADATA_TYPE.NO_METADATA) {
                    current_state = ReceiveState.SEND_FILEPATH;
                }
            }
        }
        if (file_available == false) {
            device_status.setFileToDL(0);
            LogStringLocal("[INFO] No files available!");
            console.log("[INFO] No files available!");
            current_state = ReceiveState.SEND_END;
        } else {
            let filename = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '').replace(/:/g, '').replace(/ /g, '');
            device_status.setCurrentFilename(filename);
            LogStringLocal("[INFO] Filename: " + device_status.getCurrentFilename());
            console.log("[INFO] Filename: " + device_status.getCurrentFilename());
        }
    }
            
    if (current_state == ReceiveState.FINISH_RECEIVING) {
        bar1.stop();
        //console.log("\n");
        temp_file_buff = Buffer.alloc(0);
        temp_file_buff = Buffer.concat([temp_file_buff, device_status.getFileBuffer()]);
        fs.appendFile("./" + device_status.getDeviceDirectory() + '/' + device_status.getCurrentFilename() + device_status.getExtension(), temp_file_buff, function (err) {
            temp_file_buff = Buffer.alloc(0);
            if (err) return LogStringLocal(err);
            LogStringLocal("[INFO] Data written to file " + device_status.getCurrentFilename() + " successfully");
            //console.log("[INFO] Data written to file " + device_status.getCurrentFilename() + " successfully");
        });

        if (device_status.getCameraType() == CAMERA_TYPE.DUALCAM) {
            if (device_status.getFileToDL().search("video") > -1) {
                ConvertVideoFile(device_status.getDeviceDirectory(), device_status.getCurrentFilename(), device_status.getExtension());
            }
        }

        device_status.resetReceivedPackageCnt();
        device_status.clearBuffer();

        if ((device_status.getCameraType() == CAMERA_TYPE.DUALCAM) && (metadata_type == METADATA_TYPE.AT_END)) {
            current_state = ReceiveState.SEND_METADATA_REQUEST;
        } else {
            current_state = ReceiveState.LOOK_FOR_FILES;
        }
    }

    if (current_state == ReceiveState.SEND_FILEPATH) {
        console.log("[INFO] Requesting file...");
        device_status.clearBuffer();
        device_status.setLastCRC(0);
        const query = Buffer.from([0, 8, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
        query.write(device_status.getFileToDL(), 4);
        LogStringLocal('[SERVER.SOCKET.TX]: ' + query.toString('hex'));
        conn.write(query);
        current_state = ReceiveState.WAIT_FOR_CMD;
    }

    if (current_state == ReceiveState.REPEAT_PACKET) {
        console.log("[INFO] Requesting for a repeat of last packet...");
        let offset = device_status.getReceivedPackageCnt();
        let query = Buffer.from([0, 2, 0, 4, 0, 0, 0, 0]);
        query.writeUInt32BE(offset, 4);
        conn.write(query);
        current_state = ReceiveState.WAIT_FOR_CMD;
    }

    if (current_state == ReceiveState.SEND_METADATA_REQUEST) {
        console.log("[INFO] Requesting metadata...");
        const query = Buffer.from([0, 10, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
        query.write(device_status.getFileToDL(), 4);
        LogStringLocal('[SERVER.SOCKET.TX]: ' + query.toString('hex'));
        conn.write(query);
        current_state = ReceiveState.WAIT_FOR_CMD;
    }

    if (current_state == ReceiveState.SEND_COMPLETE) {
        console.log("[INFO] Completing upload");
        // Close session
        const query = Buffer.from([0, 5, 0, 4, 0, 0, 0, 0]);
        conn.write(query);

        device_status.setTotalPackages(0);
        device_status.resetReceivedPackageCnt();
        device_status.setLastCRC(0);
        device_status.setCameraType(CAMERA_TYPE.NONE);

        current_state = ReceiveState.END;
    }

    if (current_state == ReceiveState.LOOK_FOR_FILES) {
        console.log("[INFO] Looking for more files...");
        // var waitTill = new Date(new Date().getTime() + 1000);
        // while(waitTill > new Date()){}
        const query = Buffer.from([0, 9]);
        conn.write(query);
        current_state = ReceiveState.INIT;
    }

    if (current_state == ReceiveState.SEND_END) {
        console.log("[INFO] Closing session");
        const query = Buffer.from([0, 0, 0, 0]);
        conn.write(query);
        current_state = ReceiveState.END;
         //conn.end();
    }

    return current_state;
}