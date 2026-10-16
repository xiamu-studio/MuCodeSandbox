declare module 'stun' {
  import type { Socket, RemoteInfo } from 'node:dgram';
  import { EventEmitter } from 'node:events';
  interface Message { transactionId: Buffer; addXorAddress(address: string, port: number): unknown; addSoftware(value: string): unknown; getXorAddress(): { address: string; port: number }; }
  interface Server extends EventEmitter { listen(port: number, address: string, callback: () => void): void; send(message: Message, port: number, address: string): boolean; close(): void; }
  const stun: { constants: Record<string, number | string>; createServer(options: { type: 'udp4'; socket?: Socket }): Server; createMessage(type: number, transaction?: Buffer): Message; request(url: string): Promise<Message> };
  export default stun;
}
