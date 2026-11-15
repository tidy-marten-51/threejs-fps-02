// Every sound is synthesised: no audio files ride along with the game. A shot is a noise
// burst through a low-pass with a square blip under it, pitched per weapon; a reload is
// two filtered clicks; the bomb beeps, the defuse kit zips, and the round stingers are
// three-note figures. Sounds from other actors are placed by distance — quieter and
// darker the further away — so a firefight across the yard sounds like one. The context
// wakes on the first click (the pointer lock), as browsers require.
export function createAudio() {
  let ctx = null;
  let master = null;
  let noiseBuffer = null;

  function wake() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  }

  function noiseBurst(at, duration, filterFreq, gain, type = 'lowpass') {
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = filterFreq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + duration);
    src.connect(filter).connect(g).connect(master);
    src.start(at);
    src.stop(at + duration + 0.02);
  }

  function blip(at, freq, duration, gain, type = 'square') {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq * 0.5), at + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + duration);
    osc.connect(g).connect(master);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }

  // distance 0 = the player's own gun; beyond that the shot darkens and fades.
  function shot(def, distance = 0) {
    if (!ctx) return;
    const at = ctx.currentTime;
    const fade = distance === 0 ? 1 : Math.max(0.06, 1 - distance / 70);
    const cutoff = distance === 0 ? 3800 : Math.max(500, 3800 - distance * 55);
    noiseBurst(at, def.soundLength, cutoff, 0.5 * fade);
    blip(at, 150 * def.soundPitch, def.soundLength * 0.8, 0.22 * fade);
  }

  function dryFire() {
    if (!ctx) return;
    blip(ctx.currentTime, 900, 0.04, 0.08, 'square');
  }

  function reload() {
    if (!ctx) return;
    const at = ctx.currentTime;
    noiseBurst(at + 0.05, 0.05, 2000, 0.12, 'bandpass');
    noiseBurst(at + 0.55, 0.05, 1600, 0.14, 'bandpass');
    noiseBurst(at + 1.0, 0.06, 2400, 0.16, 'bandpass');
  }

  function hit(kill) {
    if (!ctx) return;
    const at = ctx.currentTime;
    blip(at, kill ? 1320 : 1050, 0.07, 0.16, 'sine');
    if (kill) blip(at + 0.07, 1760, 0.09, 0.16, 'sine');
  }

  function hurt() {
    if (!ctx) return;
    noiseBurst(ctx.currentTime, 0.12, 700, 0.2);
  }

  function beep(final = false) {
    if (!ctx) return;
    blip(ctx.currentTime, final ? 1560 : 1180, final ? 0.3 : 0.07, 0.14, 'sine');
  }

  function plantDone() {
    if (!ctx) return;
    const at = ctx.currentTime;
    blip(at, 880, 0.08, 0.14, 'sine');
    blip(at + 0.1, 1174, 0.12, 0.14, 'sine');
  }

  function explosion() {
    if (!ctx) return;
    const at = ctx.currentTime;
    noiseBurst(at, 1.1, 300, 0.9);
    blip(at, 68, 0.9, 0.5, 'sine');
  }

  function flashbang() {
    if (!ctx) return;
    const at = ctx.currentTime;
    noiseBurst(at, 0.5, 6000, 0.4, 'highpass');
    blip(at, 3400, 0.7, 0.1, 'sine');
  }

  function throwWhoosh() {
    if (!ctx) return;
    noiseBurst(ctx.currentTime, 0.16, 1200, 0.08, 'bandpass');
  }

  function buy() {
    if (!ctx) return;
    blip(ctx.currentTime, 1560, 0.06, 0.1, 'sine');
  }

  function denied() {
    if (!ctx) return;
    blip(ctx.currentTime, 220, 0.12, 0.12, 'square');
  }

  function stinger(win) {
    if (!ctx) return;
    const at = ctx.currentTime;
    const notes = win ? [523, 659, 784] : [392, 330, 262];
    notes.forEach((freq, i) => blip(at + i * 0.13, freq, 0.22, 0.14, 'triangle'));
  }

  return { wake, shot, dryFire, reload, hit, hurt, beep, plantDone, explosion, flashbang, throwWhoosh, buy, denied, stinger };
}
