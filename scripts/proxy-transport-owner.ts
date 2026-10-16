import { pathToFileURL } from 'node:url';

const [moduleFile, limaHome, instanceName, targetPort, guestPort] = process.argv.slice(2);
const { ProxyTransports } = await import(pathToFileURL(moduleFile).href);
const transports = new ProxyTransports(limaHome);
try {
  const identity = await transports.open('owner-test', instanceName, '127.0.0.1', Number(targetPort), {}, Number(guestPort));
  console.log(JSON.stringify({ identity, sshPid: transports.entries.get('owner-test').child.pid }));
  process.once('SIGTERM', () => { void transports.close('owner-test').then(() => process.exit(0)); });
} catch (error) {
  console.error(String(error)); await transports.close('owner-test'); process.exitCode = 1;
}
