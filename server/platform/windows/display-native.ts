import {z} from 'zod';
import {AppError} from '../../errors.ts';

// Read the actual X11 screen and published XSETTINGS, not the configuration
// file we wrote or a fabricated browser screen. dump_xsettings is supplied by
// xsettingsd and reads the selection owner's _XSETTINGS_SETTINGS property.
// https://specifications.freedesktop.org/xsettings/latest/
// https://raw.githubusercontent.com/derat/xsettingsd/master/dump_xsettings.cc
export const WINDOWS_NATIVE_DISPLAY_INSPECT=`import json,re,subprocess
def read(command,maximum):
 result=subprocess.run(command,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=3,check=True)
 if len(result.stdout)>maximum:raise RuntimeError('Display measurement too large')
 return result.stdout.decode('ascii',errors='strict')
screen=read(['/usr/bin/xdpyinfo'],65536)
dimensions=re.findall(r'^\\s*dimensions:\\s+([0-9]+)x([0-9]+) pixels\\s+\\([0-9]+x[0-9]+ millimeters\\)\\s*$',screen,re.M)
if len(dimensions)!=1:raise RuntimeError('Invalid native screen')
width,height=map(int,dimensions[0])
if not 320<=width<=8192 or not 240<=height<=8192 or width*height>16000000:raise RuntimeError('Invalid native dimensions')
settings={}
for line in read(['/usr/bin/dump_xsettings','--screen=0'],16384).splitlines():
 match=re.fullmatch(r'(Xft/DPI|Gdk/WindowScalingFactor|Gdk/UnscaledDPI) ([0-9]+)',line)
 if not match or match[1] in settings:raise RuntimeError('Invalid display density settings')
 settings[match[1]]=int(match[2])
if set(settings)!={'Xft/DPI','Gdk/WindowScalingFactor','Gdk/UnscaledDPI'}:raise RuntimeError('Missing display density settings')
dpi=settings['Xft/DPI'];factor=settings['Gdk/WindowScalingFactor'];unscaled=settings['Gdk/UnscaledDPI']
if not 98304<=dpi<=393216 or not 1<=factor<=4 or not 98304<=unscaled<=196608 or abs(dpi-factor*unscaled)>2:raise RuntimeError('Inconsistent display density')
print(json.dumps({'version':1,'width':width,'height':height,'dpi':dpi,'windowScale':factor,'unscaledDpi':unscaled}))
`;

const nativeDisplay=z.object({version:z.literal(1),width:z.number().int().min(320).max(8192),height:z.number().int().min(240).max(8192),dpi:z.number().int().min(98304).max(393216),windowScale:z.number().int().min(1).max(4),unscaledDpi:z.number().int().min(98304).max(196608)}).strict().refine(value=>value.width*value.height<=16_000_000&&Math.abs(value.dpi-value.windowScale*value.unscaledDpi)<=2);
export function parseWindowsNativeDisplay(raw:string){
 try{if(Buffer.byteLength(raw)>2048)throw Error();return nativeDisplay.parse(JSON.parse(raw));}
 catch{throw new AppError('客体原生画面尺寸或密度无法核对，请重试显示设置',409,'DISPLAY_MEASUREMENT_INVALID');}
}
