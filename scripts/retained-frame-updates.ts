import type {Plugin} from 'vite';

// Local extension of pinned noVNC 1.7.0. Pause at RFB update boundaries;
// never discard protocol bytes or recreate the decoder/canvas on tab changes.
export function retainedFrameUpdatesSource(source:string):string {
 const replace=(from:string,to:string)=>{if(source.split(from).length!==2)throw new Error('Pinned noVNC update flow changed; review retained viewer patch');source=source.replace(from,to);};
 replace('        this._viewOnly = false;','        this._viewOnly = false;\n        this._updatesPaused = false;');
 replace('    get viewOnly() { return this._viewOnly; }',`    get updatesPaused() { return this._updatesPaused; }
    set updatesPaused(value) {
        const paused = Boolean(value);
        if (this._updatesPaused === paused) { return; }
        this._updatesPaused = paused;
        if (this._rfbConnectionState !== 'connected') { return; }
        if (this._supportsContinuousUpdates) {
            this._enabledContinuousUpdates = !paused;
            RFB.messages.enableContinuousUpdates(this._sock, !paused, 0, 0,
                                                 this._fbWidth, this._fbHeight);
        }
        if (!paused) {
            RFB.messages.fbUpdateRequest(this._sock, false, 0, 0,
                                         this._fbWidth, this._fbHeight);
        }
    }

    // Repaint the retained back buffer and ask the same authenticated server
    // for a complete frame. No decoder reset, site reload or new connection.
    refreshFrame() {
        if (this._rfbConnectionState !== 'connected' || this._updatesPaused ||
            !this._fbWidth || !this._fbHeight) { return; }
        this._display._damage(0, 0, this._fbWidth, this._fbHeight);
        this._display.flip();
        RFB.messages.fbUpdateRequest(this._sock, false, 0, 0,
                                     this._fbWidth, this._fbHeight);
    }

    get viewOnly() { return this._viewOnly; }`);
 replace('        RFB.messages.fbUpdateRequest(this._sock, false, 0, 0, this._fbWidth, this._fbHeight);', '        if (!this._updatesPaused) { RFB.messages.fbUpdateRequest(this._sock, false, 0, 0, this._fbWidth, this._fbHeight); }');
 replace('if (ret && !this._enabledContinuousUpdates)', 'if (ret && !this._updatesPaused && !this._enabledContinuousUpdates)');
 replace('                if (first) {\n                    this._enabledContinuousUpdates = true;', '                if (!this._updatesPaused) {\n                    this._enabledContinuousUpdates = true;');
 return source;
}
export function retainedFrameUpdatesPlugin():Plugin {
 return {name:'mu-retained-frame-updates',enforce:'pre',transform(source,id){
  if(!id.split('?')[0].replaceAll('\\','/').endsWith('/node_modules/@novnc/novnc/core/rfb.js'))return;
  return {code:retainedFrameUpdatesSource(source),map:null};
 }};
}
