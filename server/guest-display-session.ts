import { displayPixels, type DisplayRequest, type GuestDisplay } from '../shared/guest-display.ts';

export interface DisplaySessionOperations {
  assertCurrent(): void;
  applyDpi(request: DisplayRequest): Promise<void>;
  resizePixels(width: number, height: number): Promise<{ width: number; height: number }>;
  readNativeScreen(): Promise<{ width: number; height: number }>;
  resizeBrowserWindow(width: number, height: number): Promise<void>;
  waitForDensity(): Promise<void>;
}

export async function configureGuestDisplay(previous: GuestDisplay | undefined, input: DisplayRequest, operations: DisplaySessionOperations): Promise<GuestDisplay> {
  const requested = displayPixels(input);
  const mode = requested.mode ?? 'adaptive';
  operations.assertCurrent();
  if (previous?.matched && previous.width === requested.width && previous.height === requested.height && previous.scaleFactor === requested.scaleFactor) {
    // Mode changes at equal dimensions do not change the real screen/window.
    return { ...previous, mode };
  }
  await operations.applyDpi(input);
  operations.assertCurrent();
  const actual = await operations.resizePixels(requested.width, requested.height);
  operations.assertCurrent();
  let browserScaleFactor = 0, screenWidth = 0, screenHeight = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    const screen = await operations.readNativeScreen();
    operations.assertCurrent();
    screenWidth = screen.width; screenHeight = screen.height;
    const factor = actual.width / screenWidth;
    browserScaleFactor = Number.isFinite(factor) && factor >= 1 && factor <= 4 ? Math.round(factor * 1000) / 1000 : 0;
    if (Math.abs(browserScaleFactor - requested.scaleFactor) < .05 && screenWidth === requested.cssWidth && screenHeight === requested.cssHeight) break;
    if (attempt < 11) await operations.waitForDensity();
  }
  await operations.resizeBrowserWindow(requested.cssWidth, requested.cssHeight);
  operations.assertCurrent();
  const matched = actual.width === requested.width && actual.height === requested.height && screenWidth === requested.cssWidth && screenHeight === requested.cssHeight && Math.abs(browserScaleFactor - requested.scaleFactor) < .05;
  return { ...requested, ...actual, mode, browserScaleFactor, screenWidth, screenHeight, matched };
}
