export function diagnosticValue(value:unknown,seen?:Set<object>,depth?:number):any;
export function diagnosticEvent(event:{type:string;data:unknown},sequence:number):string;
export default function windowsTestDiagnostics(source:AsyncIterable<{type:string;data:unknown}>):AsyncGenerator<string>;
