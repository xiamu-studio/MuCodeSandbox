export const TRANSFER_MAX_BYTES=150*1024*1024;
export const CLIPBOARD_MAX_BYTES=64*1024;
export type TransferZone='incoming'|'outgoing'|'downloads';
export interface TransferFile {zone:TransferZone;name:string;bytes:number;modifiedAt:string;path:string;kind?:'file'|'directory';relativePath?:string;revision?:string}
export interface TransferFilePage {files:TransferFile[];total:number;nextCursor:string|null}
export const TRANSFER_FOLDERS={incoming:'/home/dev/Transfers/Incoming',outgoing:'/home/dev/Transfers/Outgoing',downloads:'/home/dev/Downloads'} as const;

export interface SavedTransferFile {name:string;path:string;bytes:number;zone:TransferZone}
export interface SharedTransferDirectory {id:string;guestPath:string;writable:boolean}
