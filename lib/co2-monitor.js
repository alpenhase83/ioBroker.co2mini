const os		= require('os');
const buffer	= require('buffer');
const util		= require('util');
const usb		= require('usb');

const EventEmitter = require('events').EventEmitter;

class Co2Monitor extends EventEmitter {
    constructor() {
        super();

        this.co2Device 		= null;
        this.co2Interface 	= null;
        this.co2Endpoint  	= null;

        this.idVendor  = 0x04D9;
        this.idProduct = 0xA052;

        this.buf = new Buffer(8);

        this.buf.writeUInt8(0xc4,0);
        this.buf.writeUInt8(0xc6,1);
        this.buf.writeUInt8(0xc0,2);
        this.buf.writeUInt8(0x92,3);
        this.buf.writeUInt8(0x40,4);
        this.buf.writeUInt8(0x23,5);
        this.buf.writeUInt8(0xdc,6);
        this.buf.writeUInt8(0x96,7);

		process.on('SIGINT', () => {
			this.disconnect(function(cb) {
				if(cb) process.exit();
			});
		});
    }

	setVendorId(vid) {
		this.idVendor = vid;
	}

	setProductId(pid) {
		this.idProduct = pid;
	}

	getVendorId() {
		return this.idVendor;
	}

	getProductId() {
		return this.idProduct;
	}

    connect() {
        this.co2Device = usb.findByIds(this.idVendor, this.idProduct);
		
		if(!this.co2Device) {
			this.emit("error", 'CO2 device not found');
		}
		else {
			try {
				this.co2Device.open();

				if(!this.co2Device.interfaces[0]) {
					throw new Error('Interface not found on Device!');
				}
				else {
					this.co2Interface = this.co2Device.interfaces[0];

					if(os.platform() === 'linux') {
						if(this.co2Interface.isKernelDriverActive()) {
							this.co2Interface.detachKernelDriver();
						}
					}

					this.co2Device.controlTransfer(0x21,0x09,0x0300,0x00, this.buf, function(error, data) {
						if(error) {
							throw new Error("Error in opening control transfer: " + error);
						}
					});

					this.co2Interface.claim();
					this.co2Endpoint = this.co2Interface.endpoints[0];
					
					this.emit("connected", this.co2Device);
				}

			} catch (error) {
				throw new Error(error);
			}
		}
    }

	disconnect(cb) {
		try {
			this.co2Endpoint.stopPoll();
			this.co2Interface.release(true, (error) => {
				if(error) {
					this.emit('error', error);
				}
				else {
					this.co2Device.close();
					cb(true);
				}
			});
		}
		catch(error) {
			throw new Error(error);
		}
	}

	startTransfer() {
		this._startPoll(this.co2Endpoint, (endpoint) => {
			if(endpoint !== null) {
				let decryptedData = {
					co2: 		 null,
					temperature: null
				};

				endpoint.on('data', (data) => {
					let decrypted = this._decrypt(this.buf, data);
					let values = {};

					let op = decrypted[0];
					values[op] = decrypted[1] << 8 | decrypted[2];

					if(values[80]) {
						decryptedData.co2 = values[80];
						this.emit("co2", decryptedData.co2);
						if(decryptedData.temperature !== null) this.emit("data", JSON.stringify(decryptedData));
					}

					if(values[66]) {
						decryptedData.temperature = (values[66]/16.0-273.15).toFixed(3);
						this.emit("temp", decryptedData.temperature);
						if(decryptedData.co2 !== null) this.emit("data", JSON.stringify(decryptedData));
					}

					if(values[68]) {
						let RH = (values[68]/100);
					}

					this.emit("rawData", data);
				})

				endpoint.on("error", (error) => {
					this.emit("error", error);
				});

				endpoint.on("end", (error) => {});
			}
		});
	}

	_startPoll(endpoint, cb) {
		try{
			endpoint.transfer(8, function(error, data) {
				if(error) {
					 throw new Error(error);
				}
			});

			endpoint.startPoll(8, 64);
			cb(endpoint);
		} catch(e) {
			cb(null);
		}
	}

	_decrypt(buf, data) {
		const cstate = [0x48,  0x74,  0x65,  0x6D,  0x70,  0x39,  0x39,  0x65];
		const shuffle = [2, 4, 0, 7, 1, 6, 5, 3];
		let i;

		let phase1 = [];
		for(i = 0; i < shuffle.length; i++) {
			phase1[shuffle[i]] = data[i];
		}

		let phase2 = [];
		for(i = 0; i < 8; i++) {
			phase2[i] = phase1[i] ^ buf[i];
		}

		let phase3 = [];
		for(i = 0; i < 8; i++) {
			phase3[i] =  ((phase2[i] >> 3) | (phase2[ (i - 1 + 8) % 8 ] << 5) ) & 0xff;
		}

		let ctmp = [];
		for(i = 0; i < 8; i++) {
			ctmp[i] = ( (cstate[i] >> 4) | (cstate[i] << 4) ) & 0xff;
		}

		let out = [];
		for(i = 0; i < 8 ; i++) {
			out[i] = ((0x100 + phase3[i] - ctmp[i]) & 0xff);
		}

		return out;
	}
}

module.exports = Co2Monitor;