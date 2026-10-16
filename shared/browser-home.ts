// This reserved URL is a configuration value; launchers resolve it to the bundled page.
export const BROWSER_HOME_URL = 'https://home.mucodesandbox.invalid/';
export function usesBrowserHome(url:string) {
  return [BROWSER_HOME_URL,'https://example.com','https://example.com/'].includes(url);
}
