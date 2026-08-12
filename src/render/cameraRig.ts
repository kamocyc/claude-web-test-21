import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { MAP_H, MAP_W, TILE_M } from '@shared/constants';

/**
 * RTS 風のカメラ操作。
 * ドラッグでパン、ホイールでズーム、右ドラッグ（または Q/E）で回転、
 * WASD / 矢印キーでもパンできる。
 */
export class CameraRig {
  readonly camera: PerspectiveCamera;
  /** 注視点（地面上）。 */
  readonly target = new Vector3();
  /** 注視点からの距離 (m)。 */
  distance = 600;
  /** 方位角（ラジアン）。 */
  azimuth = Math.PI * 0.25;
  /** 仰角（ラジアン）。 */
  elevation = MathUtils.degToRad(52);

  private readonly keys = new Set<string>();
  private dragging: 'pan' | 'orbit' | null = null;
  private lastX = 0;
  private lastY = 0;
  /** ドラッグが「移動」と見なされたか（クリック判定に使う）。 */
  moved = false;

  static readonly MIN_DISTANCE = 60;
  static readonly MAX_DISTANCE = 2600;

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(50, aspect, 1, 12000);
    this.target.set((MAP_W * TILE_M) / 2, 0, (MAP_H * TILE_M) / 2);
    this.update(0);
  }

  attach(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => {
      // 中ボタン or 右ボタン or Shift+左 で回転、それ以外はツールに任せる
      if (e.button === 2 || e.button === 1 || (e.button === 0 && e.shiftKey)) {
        this.dragging = 'orbit';
      } else if (e.button === 0 && e.altKey) {
        this.dragging = 'pan';
      } else {
        return;
      }
      this.moved = false;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 2) this.moved = true;

      if (this.dragging === 'orbit') {
        this.azimuth -= dx * 0.005;
        this.elevation = MathUtils.clamp(this.elevation + dy * 0.005, MathUtils.degToRad(12), MathUtils.degToRad(88));
      } else {
        this.panScreen(-dx, -dy);
      }
    });

    const end = (e: PointerEvent): void => {
      if (!this.dragging) return;
      this.dragging = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = Math.exp(e.deltaY * 0.0012);
        this.distance = MathUtils.clamp(this.distance * factor, CameraRig.MIN_DISTANCE, CameraRig.MAX_DISTANCE);
      },
      { passive: false },
    );

    window.addEventListener('keydown', (e) => {
      // 入力欄にフォーカスがあるときはカメラを動かさない
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** 画面上の移動量だけ注視点を動かす。 */
  private panScreen(dx: number, dy: number): void {
    const scale = this.distance * 0.0016;
    const cos = Math.cos(this.azimuth);
    const sin = Math.sin(this.azimuth);
    this.target.x += (dx * cos - dy * sin) * scale;
    this.target.z += (dx * sin + dy * cos) * scale;
    this.clampTarget();
  }

  private clampTarget(): void {
    this.target.x = MathUtils.clamp(this.target.x, 0, MAP_W * TILE_M);
    this.target.z = MathUtils.clamp(this.target.z, 0, MAP_H * TILE_M);
  }

  /** マップ上の座標へカメラを寄せる。 */
  lookAtWorld(x: number, z: number): void {
    this.target.set(x, 0, z);
    this.clampTarget();
  }

  update(dt: number): void {
    // キーボードによるパン
    let kx = 0;
    let kz = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) kz -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) kz += 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) kx -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) kx += 1;
    if (kx !== 0 || kz !== 0) {
      const speed = this.distance * 1.1 * dt;
      const cos = Math.cos(this.azimuth);
      const sin = Math.sin(this.azimuth);
      this.target.x += (kx * cos - kz * sin) * speed;
      this.target.z += (kx * sin + kz * cos) * speed;
      this.clampTarget();
    }
    if (this.keys.has('q')) this.azimuth += dt * 1.2;
    if (this.keys.has('e')) this.azimuth -= dt * 1.2;

    const cosE = Math.cos(this.elevation);
    this.camera.position.set(
      this.target.x + this.distance * cosE * Math.sin(this.azimuth),
      this.target.y + this.distance * Math.sin(this.elevation),
      this.target.z + this.distance * cosE * Math.cos(this.azimuth),
    );
    this.camera.lookAt(this.target);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** ズームの度合い 0（寄り）..1（引き）。 */
  get zoomFraction(): number {
    return (this.distance - CameraRig.MIN_DISTANCE) / (CameraRig.MAX_DISTANCE - CameraRig.MIN_DISTANCE);
  }
}
