async function configureIdentity(contents, identity, setup, onError) {
  const metadata = await contents.executeJavaScript(`navigator.userAgentData ? navigator.userAgentData.getHighEntropyValues(['architecture','bitness','model','platformVersion','fullVersionList']) : null`);
  const userAgent = contents.getUserAgent();
  const debuggerAPI = contents.debugger;
  debuggerAPI.attach('1.3');
  const apply = async sessionId => {
    if (!sessionId) {
      await setup(debuggerAPI.sendCommand('Emulation.setTimezoneOverride', { timezoneId: identity.timezone }));
      await setup(debuggerAPI.sendCommand('Emulation.setLocaleOverride', { locale: identity.locale }));
    }
    await setup(debuggerAPI.sendCommand('Emulation.setUserAgentOverride', { userAgent, acceptLanguage: `${identity.locale},${identity.locale.split('-')[0]}`, ...(metadata ? { userAgentMetadata: metadata } : {}) }, sessionId));
  };
  debuggerAPI.on('message', (_event, method, params) => {
    if (method !== 'Target.attachedToTarget') return;
    void (async () => {
      await apply(params.sessionId);
      await debuggerAPI.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, params.sessionId);
      await debuggerAPI.sendCommand('Runtime.runIfWaitingForDebugger', {}, params.sessionId);
    })().catch(onError);
  });
  await apply();
  await setup(debuggerAPI.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }));
}
module.exports = { configureIdentity };
