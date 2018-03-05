
import { toPromise, wait } from './utils';
import { factory } from './commands';
import { factory as decodeFactory } from './commands/decoder';
import { Peripheral, Characteristic } from 'noble';
import { CommandWithRaw } from './commands/types';

enum ServicesUUID {
  apiV2ControlService = '00010001574f4f2053706865726f2121',
  nordicDfuService =    '00020001574f4f2053706865726f2121'
};

enum CharacteristicUUID {
  apiV2Characteristic =       '00010002574f4f2053706865726f2121',
  dfuControlCharacteristic =  '00020002574f4f2053706865726f2121',
  dfuInfoCharacteristic =     '00020004574f4f2053706865726f2121',
  antiDoSCharacteristic =     '00020005574f4f2053706865726f2121'
};


// TS workaround until 2.8 (not released), then ReturnType<factory>
const commandsType = (false as true) && factory();
const decodeType = (false as true) && decodeFactory((_) => null);

enum QUEUE_MODE {
  NO_QUEUE, // NOT IMPLEMENTED
  QUEUE,
  QUEUE_TRYAGAIN, // NOT IMPLEMENTED
  QUEUE_IGNORE_ERROR // NOT IMPLEMENTED
}

interface CommandQueueItem {
  promise: PromiseLike<any>,
  command: CommandWithRaw,
  characteristic: Characteristic,
  timeout?: NodeJS.Timer,
  success: () => any,
  reject: () => any
}

export class Toy {
  peripheral: Peripheral;
  apiV2Characteristic?: Characteristic;
  dfuControlCharacteristic?: Characteristic;
  dfuInfoCharacteristic?: Characteristic;
  antiDoSCharacteristic?: Characteristic;
  commands: typeof commandsType;
  decoder: typeof decodeType;
  commandQueue: Array<CommandQueueItem>;
  executing: CommandQueueItem | null;
  started: boolean;
  qeueMode: QUEUE_MODE;

  constructor(p: Peripheral) {
    this.peripheral = p;
  }

  async init() {
    const p = this.peripheral

    this.commandQueue = [];
    this.executing = null;
    this.commands = factory();
    this.decoder = decodeFactory((error, packet) => this.onPacketRead(error, packet));
    this.started = false;
    this.qeueMode = QUEUE_MODE.QUEUE;

    await toPromise(p.connect.bind(p));
    await toPromise(p.discoverAllServicesAndCharacteristics.bind(p));
    this.bindServices();
    await this.bindListeners();


  }

  async start() {
    // start
    await this.init();

    await this.write(this.antiDoSCharacteristic, "usetheforce...band");
    await toPromise(this.dfuControlCharacteristic.subscribe.bind(this.dfuControlCharacteristic))
    await toPromise(this.apiV2Characteristic.subscribe.bind(this.apiV2Characteristic))

    this.started = true;

    await this.wake();
  }

  bindServices() {
    this.peripheral.services.forEach(s => s.characteristics.forEach(c => {
      console.log(c.uuid);
      if (c.uuid === CharacteristicUUID.antiDoSCharacteristic) {
        this.antiDoSCharacteristic = c;
      } else if (c.uuid === CharacteristicUUID.apiV2Characteristic) {
        this.apiV2Characteristic = c;
      } else if (c.uuid === CharacteristicUUID.dfuControlCharacteristic) {
        this.dfuControlCharacteristic = c;
      } else if (c.uuid === CharacteristicUUID.dfuInfoCharacteristic) {
        this.dfuInfoCharacteristic = c;
      }
    }));
  }

  async bindListeners() {
    this.apiV2Characteristic.on('read', (data: Buffer, isNotification: boolean) => this.onApiRead(data, isNotification));
    this.apiV2Characteristic.on('notify', (data: Buffer, isNotification: boolean) => this.onApiNotify(data, isNotification));
    this.dfuControlCharacteristic.on('notify', (data: Buffer, isNotification: boolean) => this.onDFUControlNotify(data, isNotification));
  }


  onApiRead(data: Buffer, isNotification: boolean) {
    // console.log('READAPI', data, isNotification)
    data.forEach(byte => this.decoder.add(byte));
  }

  onApiNotify(data: any, isNotification: any) {
    return this.wake();
  }

  onDFUControlNotify(data: any, isNotification: any) {
    return this.write(this.dfuControlCharacteristic, new Uint8Array([0x30]));
  }

  handleQueueError() {
    if (this.qeueMode === QUEUE_MODE.QUEUE) {
      this.executing.reject();
      clearTimeout(this.executing.timeout);
      this.executing = null;
      this.processCommand();
    }
  }

  onPacketRead(error: string, packet: CommandWithRaw) {
    if (error) {
      console.error('There was a parse error', error);
    } else if (this.executing){
      const { deviceId, commandId, sequenceNumber } = packet;
      const sentCommand = this.executing.command;
      if (deviceId === sentCommand.deviceId && commandId === sentCommand.commandId && sequenceNumber === sentCommand.sequenceNumber) {
        console.log('RESPONSE COMMAND', packet);
        this.executing.success();
        clearTimeout(this.executing.timeout);
        this.executing = null;
      } else {
        console.log('RESPONSE COMMAND ERROR', packet);
        this.handleQueueError();
      }

    } else {
      console.log('PACKET RECEIVED BUT NOT EXECUTING', packet);
    }

    this.processCommand();
  }

  onCommandTimedout() {
    console.log('RESPONSE COMMAND TIMEDOUT');
    this.handleQueueError();

  }

  queue(c: Characteristic, data: CommandWithRaw) {
    if (!this.started) return;

    if (this.qeueMode === QUEUE_MODE.NO_QUEUE) {
      // TODO
    } else {
      let success;
      let reject;
      let promise = new Promise((_success, _reject)=> {
        success = _success;
        reject = _reject;
      });

      // todo add timeout;
      this.commandQueue.push({
        characteristic: c,
        command: data,
        promise,
        success,
        reject
      });
      this.processCommand();
      return promise;
    }
  }

  write(c: Characteristic, data: Uint8Array | string) {
    let buff;
    if (typeof data === 'string') {
      buff = Buffer.from(data);
    } else {
      buff = new Buffer(data);
    }
    return toPromise(c.write.bind(c, buff, true));;
  }

  processCommand() {
    if (!this.executing) {
      this.executing = this.commandQueue.shift();
      if (this.executing) {
        console.log('WRITING COMMAND', this.executing.command);
        this.executing.timeout = setTimeout(() => this.onCommandTimedout(), 5000);
        this.write(this.executing.characteristic, this.executing.command.raw);
      }
    }
  }

  wake() {
    return this.queue(this.apiV2Characteristic, this.commands.power.wake());
  }

  sleep() {
    return this.queue(this.apiV2Characteristic, this.commands.power.sleep());
  }

  roll(speed: number, heading: number, flags: Array<number>) {
    return this.queue(this.apiV2Characteristic, this.commands.driving.drive(speed, heading, flags));
  }

  async rollTime(speed: number, heading: number, time: number, flags: Array<number>) {
    let drive: boolean = true;
    console.log('DRIVE');
    setTimeout(() => drive = false, time);
    while(drive) {
      await this.queue(this.apiV2Characteristic, this.commands.driving.drive(speed, heading, flags));
    }
    console.log('STOP');
    await this.queue(this.apiV2Characteristic, this.commands.driving.drive(0, heading, flags));
  }
}