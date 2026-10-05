/**
 * @doc.type component
 * @doc.purpose Vanilla Custom Element for audio waveform visualization — framework-agnostic.
 * @doc.layer product
 * @doc.pattern Custom Element
 *
 * Usage (plain HTML / Electron renderer):
 *   <av-waveform
 *     data="[0.1,0.5,0.3,...]"
 *     position="0.4"
 *     color="#3b82f6"
 *     progress-color="#60a5fa"
 *     background-color="#1f2937"
 *     height="80"
 *     variant="bars"
 *   ></av-waveform>
 *
 * JS API:
 *   const el = document.querySelector('av-waveform');
 *   el.setData([0.1, 0.5, 0.3]);
 *   el.setPosition(0.4);
 *   el.addEventListener('av-seek', (e) => console.log(e.detail.position));
 */

export type WaveformVariant = 'bars' | 'line';

/**
 * Core waveform painter — no framework dependency.
 */
function paintWaveform(
  canvas: HTMLCanvasElement,
  data: number[],
  position: number,
  color: string,
  progressColor: string,
  backgroundColor: string,
  height: number,
  variant: WaveformVariant,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.offsetWidth || 300;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.scale(dpr, dpr);

  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, width, height);

  if (data.length === 0) return;

  const max = Math.max(...data.map(Math.abs));
  const normalized = max > 0 ? data.map((v) => v / max) : data;
  const barWidth = width / normalized.length;
  const centerY = height / 2;
  const progressX = position * width;

  if (variant === 'bars') {
    normalized.forEach((value, i) => {
      const x = i * barWidth;
      const barHeight = Math.abs(value) * (height * 0.8);
      const y = centerY - barHeight / 2;
      ctx.fillStyle = x < progressX ? progressColor : color;
      ctx.fillRect(x, y, Math.max(1, barWidth - 1), barHeight);
    });
  } else {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    normalized.forEach((value, i) => {
      const x = i * barWidth;
      const y = centerY - value * (height * 0.4);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    if (position > 0) {
      ctx.fillStyle = `${progressColor}33`;
      ctx.fillRect(0, 0, progressX, height);
    }
  }

  if (position > 0 && position < 1) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(progressX - 1, 0, 2, height);
  }
}

/**
 * `<av-waveform>` Custom Element.
 *
 * Observed attributes: data, position, color, progress-color,
 *   background-color, height, variant.
 *
 * Fires `av-seek` CustomEvent<{ position: number }> on click.
 */
export class AvWaveformElement extends HTMLElement {
  static readonly observedAttributes = [
    'data',
    'position',
    'color',
    'progress-color',
    'background-color',
    'height',
    'variant',
  ] as const;

  private _canvas: HTMLCanvasElement;
  private _data: number[] = [];
  private _position: number = 0;
  private _color: string = '#3b82f6';
  private _progressColor: string = '#60a5fa';
  private _backgroundColor: string = '#1f2937';
  private _height: number = 80;
  private _variant: WaveformVariant = 'bars';
  private _ro: ResizeObserver | null = null;

  constructor() {
    super();
    this._canvas = document.createElement('canvas');
    this._canvas.style.display = 'block';
    this._canvas.style.width = '100%';
  }

  connectedCallback(): void {
    this.style.display = 'block';
    this.style.cursor = this.onclick ? 'pointer' : 'default';
    this.appendChild(this._canvas);

    this._canvas.addEventListener('click', this._handleClick);

    this._ro = new ResizeObserver(() => this._paint());
    this._ro.observe(this);
    this._paint();
  }

  disconnectedCallback(): void {
    this._canvas.removeEventListener('click', this._handleClick);
    this._ro?.disconnect();
    this._ro = null;
  }

  attributeChangedCallback(
    name: (typeof AvWaveformElement.observedAttributes)[number],
    _oldValue: string | null,
    newValue: string | null,
  ): void {
    switch (name) {
      case 'data':
        try {
          this._data = newValue ? (JSON.parse(newValue) as number[]) : [];
        } catch {
          this._data = [];
        }
        break;
      case 'position':
        this._position = newValue !== null ? parseFloat(newValue) : 0;
        break;
      case 'color':
        this._color = newValue ?? '#3b82f6';
        break;
      case 'progress-color':
        this._progressColor = newValue ?? '#60a5fa';
        break;
      case 'background-color':
        this._backgroundColor = newValue ?? '#1f2937';
        break;
      case 'height':
        this._height = newValue !== null ? parseInt(newValue, 10) : 80;
        break;
      case 'variant':
        this._variant = newValue === 'line' ? 'line' : 'bars';
        break;
    }
    this._paint();
  }

  /** Programmatic data setter — avoids JSON serialisation overhead. */
  setData(data: number[]): void {
    this._data = data;
    this._paint();
  }

  /** Programmatic position setter (0–1). */
  setPosition(position: number): void {
    this._position = Math.max(0, Math.min(1, position));
    this._paint();
  }

  private _paint(): void {
    paintWaveform(
      this._canvas,
      this._data,
      this._position,
      this._color,
      this._progressColor,
      this._backgroundColor,
      this._height,
      this._variant,
    );
  }

  private readonly _handleClick = (e: MouseEvent): void => {
    const rect = this._canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const position = Math.max(0, Math.min(1, x / rect.width));
    this.dispatchEvent(
      new CustomEvent<{ position: number }>('av-seek', {
        detail: { position },
        bubbles: true,
        composed: true,
      }),
    );
  };
}

/**
 * Register `<av-waveform>` only once (safe to call multiple times).
 */
export function defineAvWaveform(): void {
  if (!customElements.get('av-waveform')) {
    customElements.define('av-waveform', AvWaveformElement);
  }
}
