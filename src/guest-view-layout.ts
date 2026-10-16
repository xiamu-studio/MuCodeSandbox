import { useLayoutEffect, type RefObject } from 'react';

// The embedded desktop must fit the content scrollport, not just its width.
// This affects presentation only; it never requests another guest resolution.
export function useEmbeddedGuestLayout(surface: RefObject<HTMLDivElement | null>, embedded: boolean, active: boolean, fullscreen: boolean) {
  useLayoutEffect(() => {
    const element = surface.current;
    if (!element || !embedded || !active || fullscreen) return;
    const scrollport = element.closest<HTMLElement>('.main-content');
    if (!scrollport) return;
    let frame = 0, initial = true;
    const update = () => {
      frame = 0;
      if (!element.clientWidth || !scrollport.clientHeight) return;
      const area = scrollport.getBoundingClientRect(), before = element.getBoundingClientRect();
      const wasVisible = before.bottom > area.top && before.top < area.bottom;
      const style = getComputedStyle(scrollport);
      const topPadding = parseFloat(style.paddingTop) || 0, bottomPadding = parseFloat(style.paddingBottom) || 0;
      const height = Math.max(1, Math.floor(scrollport.clientHeight - topPadding - bottomPadding));
      element.style.setProperty('--guest-view-height-limit', `${height}px`);
      if (initial || wasVisible) {
        const bounds = element.getBoundingClientRect();
        const top = area.top + scrollport.clientTop + topPadding, bottom = area.top + scrollport.clientTop + scrollport.clientHeight - bottomPadding;
        if (bounds.top < top) scrollport.scrollTop += bounds.top - top;
        else if (bounds.bottom > bottom) scrollport.scrollTop += bounds.bottom - bottom;
      }
      initial = false;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(scrollport);
    const toolbar = element.querySelector('.guest-browser-toolbar');
    if (toolbar) observer.observe(toolbar);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      element.style.removeProperty('--guest-view-height-limit');
    };
  }, [surface, embedded, active, fullscreen]);
}
