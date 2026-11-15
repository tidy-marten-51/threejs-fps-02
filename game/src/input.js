// Keyboard and mouse, and the pointer lock that turns the mouse into look. The game reads
// a plain key set, an accumulated look delta, the fire button and a queue of key presses
// (buy menu numbers, grenade slots, interact) so the simulation never touches DOM events.
export function createInput(canvas, onLockChange) {
  const keys = new Set();
  const pressed = [];
  const state = { keys, locked: false, firing: false, aiming: false, lookX: 0, lookY: 0 };

  window.addEventListener('keydown', (event) => {
    if (!event.repeat) pressed.push(event.code);
    keys.add(event.code);
    if (event.code === 'Space') event.preventDefault();
  });
  window.addEventListener('keyup', (event) => keys.delete(event.code));
  window.addEventListener('blur', () => {
    keys.clear();
    state.firing = false;
    state.aiming = false;
  });
  window.addEventListener('mousemove', (event) => {
    if (!state.locked) return;
    state.lookX += event.movementX;
    state.lookY += event.movementY;
  });
  window.addEventListener('mousedown', (event) => {
    if (!state.locked) return;
    if (event.button === 0) state.firing = true;
    if (event.button === 2) state.aiming = true;
  });
  window.addEventListener('mouseup', (event) => {
    if (event.button === 0) state.firing = false;
    if (event.button === 2) state.aiming = false;
  });
  window.addEventListener('contextmenu', (event) => event.preventDefault());
  document.addEventListener('pointerlockchange', () => {
    state.locked = document.pointerLockElement === canvas;
    if (!state.locked) {
      keys.clear();
      state.firing = false;
      state.aiming = false;
    }
    onLockChange(state.locked);
  });

  return {
    state,
    requestLock() {
      canvas.requestPointerLock();
    },
    takeLook() {
      const x = state.lookX;
      const y = state.lookY;
      state.lookX = 0;
      state.lookY = 0;
      return { x, y };
    },
    takePressed() {
      return pressed.splice(0, pressed.length);
    },
  };
}
