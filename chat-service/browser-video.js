/**
 * The Browser pane's picture, as H.264 video.
 *
 * VNC compresses every changed pixel as a still image, so a page that scrolls costs
 * the whole screen, every frame: measured on a 4-core box at 2326x1274, about 8 frames
 * a second at 40+ Mbps. A video encoder sends what moved, as motion, and the viewer's
 * browser decodes it in hardware: the same scroll ran at 30 frames a second (60 if
 * asked) at 4-7 Mbps, on about one core.
 *
 * So the screen is captured by ffmpeg (x11grab, from the browser's own X display, with
 * its cookie) and encoded with x264 for latency — ultrafast, zerolatency, no B-frames,
 * an access-unit delimiter before every frame and the parameter sets before every
 * keyframe — and each frame goes to the page as one binary WebSocket message, which
 * it hands to WebCodecs' VideoDecoder. The VNC connection stays, for everything that
 * is not the picture: keys, the pointer and its shape, the clipboard. The page asks
 * it for one pixel instead of the screen (see browser.js in public/).
 *
 * One encoder per viewer, started when a page opens /ws/browser-video and ended when
 * it closes it; the page closes it when it is hidden, so a tab in the background
 * costs nothing. A resize restarts the encoder at the new size, announced first with a
 * JSON message the page reconfigures its decoder from. A viewer whose connection
 * cannot keep up gets frames dropped until the next keyframe, never a growing queue:
 * late video is worse than missing video.
 *
 * Socket protocol, at /ws/browser-video:
 *   here → page: JSON text {type:'size', width, height, codec, fps} before each
 *                encoder; then binary messages, one H.264 access unit (Annex B) each.
 */
import { spawn } from 'child_process';
import WebSocket from 'ws';
import { DISPLAY, currentScreenSize, screenEvents, xEnv } from './browser.js';

const FFMPEG = process.env.TRIPLEC_FFMPEG || 'ffmpeg';
export const FPS = (() => {
  const n = Number(process.env.TRIPLEC_BROWSER_FPS);
  return Number.isInteger(n) && n >= 5 && n <= 60 ? n : 30;
})();
// An encoder is about a core; more viewers than this at once fall back to VNC.
export const MAX_VIEWERS = 3;
// Past this much unsent, the viewer is not keeping up: drop to the next keyframe.
const BEHIND = 2 * 1024 * 1024;

let viewers = 0;
export const videoViewers = () => viewers;

/**
 * The H.264 level for a frame size, as the codec string's last byte, or null when the
 * frame is bigger than level 5.1 — which is what hardware decoders reliably take.
 * Constrained baseline (42E0), because that is what x264's baseline profile writes.
 */
export function codecFor(width, height) {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const levels = [[3600, 0x1f], [8192, 0x29], [8704, 0x2a], [22080, 0x32], [36864, 0x33]];
  const level = levels.find(([max]) => macroblocks <= max);
  if (!level) return null;
  return { codec: `avc1.42E0${level[1].toString(16).toUpperCase().padStart(2, '0')}`, level: (level[1] / 10).toFixed(1) };
}

/** ffmpeg's arguments for the screen at `width` x `height`. */
export function ffmpegArgs({ width, height, fps = FPS, display = DISPLAY, level = '5.1' }) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(fps), '-video_size', `${width}x${height}`, '-i', display,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-profile:v', 'baseline', '-level:v', level, '-pix_fmt', 'yuv420p',
    // Quality-led, with a ceiling: a still page costs almost nothing, a scroll is capped.
    '-crf', '23', '-maxrate', '12M', '-bufsize', '2M',
    // A keyframe every 3 seconds, so a viewer that dropped frames is never long without one.
    '-g', String(fps * 3),
    '-x264-params', 'aud=1:repeat-headers=1',
    '-f', 'h264', 'pipe:1',
  ];
}

/**
 * Splits an Annex B byte stream into access units at each access-unit delimiter (NAL
 * type 9), which x264 writes before every frame when asked (aud=1). Returns a function
 * taking the next chunk of the stream and answering the units it completed.
 */
export function accessUnitSplitter() {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    const starts = [];
    for (let i = 0; i + 3 < buf.length; i++) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1 && (buf[i + 3] & 0x1f) === 9) {
        // A four-byte start code begins one byte earlier.
        starts.push(i > 0 && buf[i - 1] === 0 ? i - 1 : i);
        i += 3;
      }
    }
    const units = [];
    for (let k = 0; k + 1 < starts.length; k++) units.push(buf.subarray(starts[k], starts[k + 1]));
    if (starts.length) buf = Buffer.from(buf.subarray(starts.at(-1)));
    return units;
  };
}

/** Whether an access unit holds an IDR slice (NAL type 5): a frame a decoder can start at. */
export function isKeyframe(unit) {
  for (let i = 0; i + 3 < unit.length; i++) {
    if (unit[i] === 0 && unit[i + 1] === 0 && unit[i + 2] === 1) {
      if ((unit[i + 3] & 0x1f) === 5) return true;
      i += 2;
    }
  }
  return false;
}

/** Serve one /ws/browser-video socket. */
export function serveVideo(ws) {
  if (viewers >= MAX_VIEWERS) {
    ws.close(4429, `already ${MAX_VIEWERS} video viewers`);
    return;
  }
  viewers += 1;
  let proc = null;
  let closed = false;
  let stderr = '';

  const stop = () => {
    if (proc) {
      const p = proc;
      proc = null;
      p.stdout.removeAllListeners('data');
      p.kill('SIGKILL');
    }
  };

  const start = async (known) => {
    stop();
    const size = known || await currentScreenSize();
    if (closed) return;
    if (!size) {
      ws.close(4404, 'the browser is not running');
      return;
    }
    const codec = codecFor(size.width, size.height);
    if (!codec) {
      // Too big for a hardware decoder: the page carries on with VNC's own picture.
      ws.close(4413, `a ${size.width}x${size.height} screen is too big to stream as video`);
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'size', width: size.width, height: size.height, codec: codec.codec, fps: FPS }));
    const p = spawn(FFMPEG, ffmpegArgs({ ...size, level: codec.level }), { env: xEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    proc = p;
    const split = accessUnitSplitter();
    // Until a keyframe has been sent there is nothing a decoder can start from.
    let waitForKey = true;
    p.stdout.on('data', (chunk) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      for (const unit of split(chunk)) {
        const key = isKeyframe(unit);
        if (ws.bufferedAmount > BEHIND) waitForKey = true;
        if (waitForKey && !key) continue;
        waitForKey = false;
        ws.send(unit, { binary: true });
      }
    });
    p.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    p.on('error', (err) => {
      if (proc === p && !closed) ws.close(1011, `video encoder failed to start: ${err.code || err.message}`);
    });
    p.on('exit', (code, signal) => {
      // Only the encoder this socket is still using; a restart kills the old one.
      if (proc !== p || closed) return;
      console.error(`browser video: ffmpeg exited (${signal || code}): ${stderr.trim().split('\n').at(-1) || 'no output'}`);
      ws.close(1011, 'video encoder stopped');
    });
  };

  const onResize = (size) => { start(size).catch(() => {}); };
  screenEvents.on('resize', onResize);
  ws.on('close', () => {
    closed = true;
    viewers -= 1;
    screenEvents.off('resize', onResize);
    stop();
  });
  ws.on('error', () => {});
  start().catch((err) => {
    if (!closed) ws.close(1011, err.message);
  });
}

/** Whether this box can stream video at all: an ffmpeg that runs. Asked once. */
let available = null;
export function videoAvailable() {
  if (available) return available;
  available = new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
  return available;
}
