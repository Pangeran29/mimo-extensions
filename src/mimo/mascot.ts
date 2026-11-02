export type MimoPose =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'insight'
  | 'appreciation'
  | 'curious'
  | 'rest'
  | 'reassure';
export type MimoGesture =
  | 'greet'
  | 'listen'
  | 'understanding'
  | 'insight'
  | 'useful'
  | 'skip'
  | 'stop'
  | 'sources'
  | 'history'
  | 'reassure'
  | 'stretch';
export type MimoMotion = 'system' | 'full' | 'reduced';

const gesturePose: Record<MimoGesture, MimoPose> = {
  greet: 'appreciation',
  listen: 'listening',
  understanding: 'appreciation',
  insight: 'insight',
  useful: 'appreciation',
  skip: 'curious',
  stop: 'rest',
  sources: 'curious',
  history: 'curious',
  reassure: 'reassure',
  stretch: 'curious',
};

/** Shared, bounded character motion. It never starts recording, AI, feedback, or audio. */
export class MimoMascot {
  readonly portrait: HTMLElement;
  readonly sprite: HTMLElement;
  private basePose: MimoPose = 'idle';
  private visible = true;
  private disposed = false;
  private transient = false;
  private animation?: Animation;
  private serial = 0;
  private finishTimer?: ReturnType<typeof setTimeout>;
  private expressionTimer?: ReturnType<typeof setTimeout>;
  private lookFrame?: number;
  private lookPoint?: { x: number; y: number };
  private motion: MimoMotion;
  private reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private cleanups: (() => void)[] = [];

  constructor(
    readonly host: HTMLElement,
    options: {
      interactive?: boolean;
      greetOnClick?: boolean;
      size?: number;
      motion?: MimoMotion;
    } = {},
  ) {
    this.motion = options.motion ?? 'system';
    host.classList.add('mimo-mascot');
    if (options.size) host.style.setProperty('--mimo-size', `${options.size}px`);
    let image = host.querySelector<HTMLImageElement>('img');
    if (!image) {
      image = new Image();
      image.src = new URL('memo/memo-slime.png', location.href).href;
      image.alt = '';
      host.append(image);
    }
    image.classList.add('mimo-fallback');
    image.draggable = false;
    let portrait = host.querySelector<HTMLElement>('[data-mimo-portrait]');
    if (!portrait) {
      portrait = document.createElement('span');
      portrait.dataset.mimoPortrait = 'true';
      image.parentElement!.insertBefore(portrait, image);
    }
    portrait.classList.add('mimo-portrait');
    if (image.parentElement !== portrait) portrait.append(image);
    this.portrait = portrait;
    this.sprite = document.createElement('span');
    this.sprite.className = 'mimo-expression';
    this.sprite.dataset.mimoSprite = 'true';
    this.sprite.setAttribute('aria-hidden', 'true');
    portrait.prepend(this.sprite);
    this.renderPose(this.basePose);
    const sheet = new Image();
    sheet.onload = () => {
      if (this.disposed || !sheet.naturalWidth || !sheet.naturalHeight) return;
      const cellRatio = sheet.naturalWidth / 4 / (sheet.naturalHeight / 2);
      this.sprite.style.width = `${Math.min(1, cellRatio) * 100}%`;
      this.sprite.style.height = `${Math.min(1, 1 / cellRatio) * 100}%`;
      portrait.dataset.spriteReady = 'true';
      host.dataset.mimoSpriteReady = 'true';
    };
    sheet.onerror = () => {
      host.dataset.mimoSpriteReady = 'false';
    };
    sheet.src = new URL('mimo/mimo-expressions.png', location.href).href;
    this.cleanups.push(() => {
      sheet.onload = sheet.onerror = null;
    });

    const visibility = () => this.syncVisibility();
    document.addEventListener('visibilitychange', visibility);
    this.reduced.addEventListener('change', visibility);
    this.cleanups.push(() => document.removeEventListener('visibilitychange', visibility));
    this.cleanups.push(() => this.reduced.removeEventListener('change', visibility));
    if (options.interactive) this.interactions(options.greetOnClick !== false);
    this.syncVisibility();
  }

  setPose(pose: MimoPose): void {
    if (this.disposed) return;
    if (this.basePose === pose) return;
    this.basePose = pose;
    if (pose === 'reassure' || pose === 'rest') this.cancelReaction();
    if (!this.transient) this.renderPose(pose);
  }

  setMotion(motion: MimoMotion): void {
    this.motion = motion;
    this.syncVisibility();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.syncVisibility();
  }

  react(gesture: MimoGesture): void {
    if (this.disposed) return;
    this.cancelReaction();
    this.host.dataset.mimoGesture = gesture;
    this.host.dataset.mimoGestureId = String(++this.serial);
    if (!this.visible || document.hidden) return;
    this.transient = true;
    this.renderPose(gesturePose[gesture]);
    const canMove = !this.isReduced() && this.host.getClientRects().length > 0;
    if (canMove) {
      const frames: Record<MimoGesture, Keyframe[]> = {
        greet: [
          { transform: 'scale(1)' },
          { transform: 'scale(1.13,.83)', offset: 0.2 },
          { transform: 'translateY(-14px) rotate(-9deg) scale(.95,1.08)', offset: 0.5 },
          { transform: 'rotate(7deg) scale(1.05,.95)', offset: 0.78 },
          { transform: 'scale(1)' },
        ],
        listen: [
          { transform: 'scale(1)' },
          { transform: 'rotate(-7deg) scale(1.03,1.05)', offset: 0.45 },
          { transform: 'rotate(3deg)', offset: 0.72 },
          { transform: 'scale(1)' },
        ],
        understanding: [
          { transform: 'scale(1)' },
          { transform: 'translateY(3px) scale(1.08,.87)', offset: 0.3 },
          { transform: 'translateY(-5px) scale(.98,1.03)', offset: 0.65 },
          { transform: 'scale(1)' },
        ],
        insight: [
          { transform: 'scale(1)' },
          { transform: 'scale(1.16,.8)', offset: 0.2 },
          { transform: 'translateY(-20px) rotate(7deg) scale(.94,1.12)', offset: 0.5 },
          { transform: 'scale(1.09,.91)', offset: 0.8 },
          { transform: 'scale(1)' },
        ],
        useful: [
          { transform: 'scale(1)' },
          { transform: 'translateY(-11px) rotate(-7deg)', offset: 0.25 },
          { transform: 'scale(1.09,.9)', offset: 0.48 },
          { transform: 'translateY(-7px) rotate(7deg)', offset: 0.7 },
          { transform: 'scale(1)' },
        ],
        skip: [
          { transform: 'scale(1)' },
          { transform: 'rotate(8deg) translateY(2px)', offset: 0.45 },
          { transform: 'rotate(-3deg)', offset: 0.75 },
          { transform: 'scale(1)' },
        ],
        stop: [
          { transform: 'scale(1)' },
          { transform: 'translateY(6px) scale(1.12,.77)', offset: 0.55 },
          { transform: 'translateY(3px) scale(1.04,.91)', offset: 0.8 },
          { transform: 'scale(1)' },
        ],
        sources: [
          { transform: 'scale(1)' },
          { transform: 'translateX(5px) rotate(7deg)', offset: 0.45 },
          { transform: 'rotate(-2deg)', offset: 0.8 },
          { transform: 'scale(1)' },
        ],
        history: [
          { transform: 'scale(1)' },
          { transform: 'translateX(-5px) rotate(-7deg)', offset: 0.45 },
          { transform: 'rotate(2deg)', offset: 0.8 },
          { transform: 'scale(1)' },
        ],
        reassure: [
          { transform: 'scale(1)' },
          { transform: 'translateY(2px) rotate(-5deg)', offset: 0.5 },
          { transform: 'scale(1)' },
        ],
        stretch: [
          { transform: 'scale(1)' },
          { transform: 'scale(.9,1.11)', offset: 0.4 },
          { transform: 'scale(1.07,.93) rotate(4deg)', offset: 0.75 },
          { transform: 'scale(1)' },
        ],
      };
      this.animation = this.portrait.animate(frames[gesture], {
        duration: gesture === 'insight' || gesture === 'useful' ? 1100 : 800,
        easing: 'cubic-bezier(.22,.8,.3,1)',
      });
      if (gesture === 'greet' || gesture === 'understanding') {
        this.expressionTimer = setTimeout(() => this.renderPose('curious'), 700);
      }
    }
    this.finishTimer = setTimeout(
      () => {
        this.transient = false;
        this.renderPose(this.basePose);
      },
      canMove ? 1700 : 1000,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelReaction();
    if (this.lookFrame) cancelAnimationFrame(this.lookFrame);
    this.cleanups.forEach((cleanup) => cleanup());
    this.cleanups = [];
  }

  private renderPose(pose: MimoPose): void {
    this.host.dataset.mimoPose = pose;
    this.sprite.dataset.pose = pose;
  }

  private isReduced(): boolean {
    return this.motion === 'reduced' || (this.motion === 'system' && this.reduced.matches);
  }

  private syncVisibility(): void {
    const sleeping = !this.visible || document.hidden;
    this.host.dataset.mimoSleeping = String(sleeping);
    this.host.dataset.mimoReduced = String(this.isReduced());
    if (sleeping || this.isReduced()) {
      this.cancelReaction();
      this.renderPose(this.basePose);
      if (this.lookFrame) cancelAnimationFrame(this.lookFrame);
      this.lookFrame = undefined;
      this.lookPoint = undefined;
      this.host.dataset.mimoPressed = 'false';
      this.portrait.style.setProperty('--mimo-look-x', '0px');
      this.portrait.style.setProperty('--mimo-look-y', '0px');
      this.portrait.style.setProperty('--mimo-look-turn', '0deg');
    }
  }

  private cancelReaction(): void {
    clearTimeout(this.finishTimer);
    clearTimeout(this.expressionTimer);
    this.finishTimer = this.expressionTimer = undefined;
    this.transient = false;
    this.animation?.cancel();
    this.animation = undefined;
  }

  private interactions(greetOnClick: boolean): void {
    const on = (name: string, callback: EventListener) => {
      this.host.addEventListener(name, callback);
      this.cleanups.push(() => this.host.removeEventListener(name, callback));
    };
    on('pointermove', ((event: PointerEvent) => {
      if (this.isReduced() || document.hidden || !this.visible) return;
      const rect = this.host.getBoundingClientRect();
      this.lookPoint = {
        x: Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1)),
        y: Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1)),
      };
      if (this.lookFrame) return;
      this.lookFrame = requestAnimationFrame(() => {
        this.lookFrame = undefined;
        this.portrait.style.setProperty('--mimo-look-x', `${(this.lookPoint?.x ?? 0) * 3}px`);
        this.portrait.style.setProperty('--mimo-look-y', `${(this.lookPoint?.y ?? 0) * 2}px`);
        this.portrait.style.setProperty('--mimo-look-turn', `${(this.lookPoint?.x ?? 0) * 3}deg`);
      });
    }) as EventListener);
    on('pointerleave', () => {
      if (this.lookFrame) cancelAnimationFrame(this.lookFrame);
      this.lookFrame = undefined;
      this.lookPoint = undefined;
      this.host.dataset.mimoPressed = 'false';
      this.portrait.style.setProperty('--mimo-look-x', '0px');
      this.portrait.style.setProperty('--mimo-look-y', '0px');
      this.portrait.style.setProperty('--mimo-look-turn', '0deg');
    });
    on('pointerdown', () => {
      this.host.dataset.mimoPressed = 'true';
    });
    on('pointerup', () => {
      this.host.dataset.mimoPressed = 'false';
    });
    on('pointercancel', () => {
      this.host.dataset.mimoPressed = 'false';
    });
    if (greetOnClick) on('click', () => this.react('greet'));
  }
}
