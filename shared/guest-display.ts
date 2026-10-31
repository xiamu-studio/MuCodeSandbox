import { z } from 'zod';

export type DisplayMode = 'fixed' | 'adaptive';
export type PresentationMode = 'native' | 'fit';
export const FIXED_DISPLAY_SCALE = 2;
export const DISPLAY_PIXEL_LIMIT = 16_000_000;
export const DISPLAY_SIDE_LIMIT = 8192;

export const displayRequestSchema = z.object({
  cssWidth: z.number().int().min(320).max(DISPLAY_SIDE_LIMIT),
  cssHeight: z.number().int().min(240).max(DISPLAY_SIDE_LIMIT),
  scaleFactor: z.number().min(1).max(4),
  // Omitted mode keeps compatibility with the older adaptive viewer/API.
  mode: z.enum(['fixed', 'adaptive']).optional(),
}).strict().superRefine((value, context) => {
  const width = Math.round(value.cssWidth * value.scaleFactor);
  const height = Math.round(value.cssHeight * value.scaleFactor);
  if (width > DISPLAY_SIDE_LIMIT || height > DISPLAY_SIDE_LIMIT || width * height > DISPLAY_PIXEL_LIMIT) {
    context.addIssue({ code: 'custom', message: '画面像素超出本机测试版限额' });
  }
  if (value.mode === 'fixed' && value.scaleFactor !== FIXED_DISPLAY_SCALE) {
    context.addIssue({ code: 'custom', path: ['scaleFactor'], message: '固定桌面保持原生 2× 像素密度' });
  }
});

export type DisplayRequest = z.infer<typeof displayRequestSchema>;
export interface GuestDisplay extends DisplayRequest {
  width: number;
  height: number;
  browserScaleFactor: number;
  densitySource?: 'xsettings';
  nativeScaleFactor?: number;
  matched: boolean;
  screenWidth?: number;
  screenHeight?: number;
}

export const FIXED_DISPLAY_PRESETS = [
  { cssWidth: 1280, cssHeight: 800 },
  { cssWidth: 1440, cssHeight: 900 },
  { cssWidth: 1600, cssHeight: 1000 },
  { cssWidth: 1920, cssHeight: 1080 },
  { cssWidth: 2560, cssHeight: 1440 },
] as const;
export const DEFAULT_FIXED_DISPLAY: DisplayRequest = {
  cssWidth: 1600, cssHeight: 1000, scaleFactor: FIXED_DISPLAY_SCALE, mode: 'fixed',
};

export function displayPixels(value: DisplayRequest) {
  const request = displayRequestSchema.parse(value);
  return { ...request, width: Math.round(request.cssWidth * request.scaleFactor), height: Math.round(request.cssHeight * request.scaleFactor) };
}

export function displayPreference(display?: GuestDisplay | null): DisplayRequest {
  if (!display) return { ...DEFAULT_FIXED_DISPLAY };
  return displayRequestSchema.parse({ cssWidth: display.cssWidth, cssHeight: display.cssHeight, scaleFactor: display.scaleFactor, mode: display.mode ?? 'adaptive' });
}

export function displayRequestKey(value: DisplayRequest) {
  return `${value.mode ?? 'adaptive'}:${value.cssWidth}x${value.cssHeight}@${value.scaleFactor}`;
}

export function fitDisplay(width: number, height: number, scaleFactor: number): DisplayRequest {
  const ratio = Number.isFinite(scaleFactor) ? Math.max(1, Math.min(4, scaleFactor)) : 1;
  const maxCssSide = Math.floor(DISPLAY_SIDE_LIMIT / ratio);
  const dimension = (value: number, minimum: number) => Math.max(minimum, Math.min(maxCssSide, Number.isFinite(value) ? Math.round(value) : minimum));
  let cssWidth = dimension(width, 320), cssHeight = dimension(height, 240);
  const reduction = Math.min(1, Math.sqrt(DISPLAY_PIXEL_LIMIT / (cssWidth * cssHeight * ratio * ratio)));
  cssWidth = Math.max(320, Math.floor(cssWidth * reduction));
  cssHeight = Math.max(240, Math.floor(cssHeight * reduction));
  // Account for rounding physical pixels, including fractional native density.
  while (Math.round(cssWidth * ratio) * Math.round(cssHeight * ratio) > DISPLAY_PIXEL_LIMIT) {
    if (cssWidth / 320 >= cssHeight / 240) cssWidth--;
    else cssHeight--;
  }
  return displayRequestSchema.parse({ cssWidth, cssHeight, scaleFactor: ratio });
}

export interface GuestPresentation {
  width: number;
  height: number;
  downscaled: boolean;
  scrolls: boolean;
}

// Only the viewer changes here: never alter the guest desktop or fake screen/DPR.
// Native presentation maps each source pixel to one physical host display pixel.
export function guestPresentation(display: Pick<GuestDisplay, 'width' | 'height'>, availableWidth: number, availableHeight: number, hostScaleFactor: number, mode: PresentationMode): GuestPresentation {
  const hostDensity = Number.isFinite(hostScaleFactor) && hostScaleFactor > 0 ? hostScaleFactor : 1;
  const nativeWidth = display.width / hostDensity, nativeHeight = display.height / hostDensity;
  const availableW = Math.max(0, availableWidth), availableH = Math.max(0, availableHeight);
  const scale = mode === 'fit' ? Math.min(1, availableW / nativeWidth, availableH / nativeHeight) : 1;
  const width = mode === 'fit' ? Math.min(availableW, nativeWidth * scale) : nativeWidth;
  const height = mode === 'fit' ? Math.min(availableH, nativeHeight * scale) : nativeHeight;
  return { width, height, downscaled: scale < 1 - 0.001, scrolls: width > availableW + 1 || height > availableH + 1 };
}
