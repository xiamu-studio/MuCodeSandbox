export const LATENCY_TARGETS = [
  {id:'google',name:'Google',host:'www.google.com',url:'https://www.google.com/generate_204'},
  {id:'cloudflare',name:'Cloudflare',host:'www.cloudflare.com',url:'https://www.cloudflare.com/cdn-cgi/trace'},
] as const;
export type LatencyTarget = typeof LATENCY_TARGETS[number]['id'];
export type LatencySample = {ok:true;lineDelayMs:number;firstByteMs:number;totalMs:number;httpStatus:number;reusedConnection:true} | {ok:false;issue:string};
export interface AccessLatency {
  target:LatencyTarget;
  checkedAt:string;
  source:'guest';
  metric:'http-url-test-unified';
  samples:LatencySample[];
  successfulSamples:number;
  medianMs:number|null;
  firstResponseMedianMs:number|null;
  minMs:number|null;
  maxMs:number|null;
}
