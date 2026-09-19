/**
 * Arc knob: a circle with a gap at the bottom whose stroke grows clockwise
 * from the bottom-left as the value rises. Vertical drag, wheel and arrow
 * keys change it; exposed as an ARIA slider. Colours come from --fill-a and
 * --fill-b on an ancestor.
 */

const SWEEP_DEG = 270;
/** Pixels of vertical pointer travel for the full 0..1 range. */
const DRAG_TRAVEL_PX = 120;
const SIZE = 56;
const STROKE = 6;

export type KnobOptions = {
  /** Fires on every change from user input, with the new 0..1 value. */
  onInput: (value: number) => void;
  label: string;
  /** Keyboard and wheel step, in 0..1 units. */
  step?: number;
};

export class ArcKnob {
  readonly element: HTMLElement;
  private readonly fill: SVGCircleElement;
  private readonly arcLength: number;
  private readonly step: number;
  private readonly onInput: (value: number) => void;
  private value = 0;
  private dragStartY = 0;
  private dragStartValue = 0;

  constructor(host: HTMLElement, options: KnobOptions) {
    this.onInput = options.onInput;
    this.step = options.step ?? 0.05;
    this.element = host;

    const radius = (SIZE - STROKE) / 2;
    const circumference = 2 * Math.PI * radius;
    this.arcLength = circumference * (SWEEP_DEG / 360);

    host.classList.add("arc-knob");
    host.setAttribute("role", "slider");
    host.setAttribute("tabindex", "0");
    host.setAttribute("aria-label", options.label);
    host.setAttribute("aria-valuemin", "0");
    host.setAttribute("aria-valuemax", "100");
    host.setAttribute("aria-orientation", "vertical");

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${SIZE} ${SIZE}`);
    svg.setAttribute("aria-hidden", "true");

    const track = this.circle(radius, "arc-track");
    this.fill = this.circle(radius, "arc-fill");
    svg.append(track, this.fill);

    const readout = document.createElement("span");
    readout.className = "arc-value";
    readout.setAttribute("aria-hidden", "true");
    host.append(svg, readout);

    this.bind(host);
    this.render();
  }

  private circle(radius: number, className: string): SVGCircleElement {
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("class", className);
    c.setAttribute("cx", String(SIZE / 2));
    c.setAttribute("cy", String(SIZE / 2));
    c.setAttribute("r", String(radius));
    c.setAttribute("fill", "none");
    c.setAttribute("stroke-width", String(STROKE));
    c.setAttribute("stroke-linecap", "round");
    // Gap at the bottom: the dash starts at 3 o'clock, so rotate it to
    // bottom-left (90 + half the gap).
    c.setAttribute(
      "transform",
      `rotate(${90 + (360 - SWEEP_DEG) / 2} ${SIZE / 2} ${SIZE / 2})`,
    );
    c.setAttribute("stroke-dasharray", `${this.arcLength} ${2 * Math.PI * radius}`);
    return c;
  }

  /** Set the value without firing onInput. */
  set(value: number): void {
    this.value = clamp(value);
    this.render();
  }

  get(): number {
    return this.value;
  }

  set disabled(off: boolean) {
    this.element.classList.toggle("disabled", off);
    this.element.setAttribute("aria-disabled", String(off));
    this.element.tabIndex = off ? -1 : 0;
  }

  private render(): void {
    this.fill.setAttribute("stroke-dashoffset", String(this.arcLength * (1 - this.value)));
    const percent = Math.round(this.value * 100);
    this.element.setAttribute("aria-valuenow", String(percent));
    this.element.setAttribute("aria-valuetext", `${percent}%`);
    const readout = this.element.querySelector(".arc-value");
    if (readout) readout.textContent = String(percent);
  }

  private commit(value: number): void {
    const next = clamp(value);
    if (next === this.value) return;
    this.value = next;
    this.render();
    this.onInput(next);
  }

  private bind(host: HTMLElement): void {
    host.addEventListener("pointerdown", (event) => {
      if (host.classList.contains("disabled") || event.button !== 0) return;
      event.preventDefault();
      host.setPointerCapture(event.pointerId);
      host.classList.add("dragging");
      this.dragStartY = event.clientY;
      this.dragStartValue = this.value;
      host.focus({ preventScroll: true });
    });

    host.addEventListener("pointermove", (event) => {
      if (!host.hasPointerCapture(event.pointerId)) return;
      const delta = (this.dragStartY - event.clientY) / DRAG_TRAVEL_PX;
      this.commit(this.dragStartValue + delta);
    });

    const endDrag = (event: PointerEvent): void => {
      if (!host.hasPointerCapture(event.pointerId)) return;
      host.releasePointerCapture(event.pointerId);
      host.classList.remove("dragging");
    };
    host.addEventListener("pointerup", endDrag);
    host.addEventListener("pointercancel", endDrag);

    host.addEventListener(
      "wheel",
      (event) => {
        if (host.classList.contains("disabled")) return;
        event.preventDefault();
        const direction = event.deltaY < 0 ? 1 : -1;
        this.commit(this.value + direction * this.step);
      },
      { passive: false },
    );

    host.addEventListener("keydown", (event) => {
      if (host.classList.contains("disabled")) return;
      let next: number | undefined;
      switch (event.key) {
        case "ArrowUp":
        case "ArrowRight":
          next = this.value + this.step;
          break;
        case "ArrowDown":
        case "ArrowLeft":
          next = this.value - this.step;
          break;
        case "PageUp":
          next = this.value + this.step * 4;
          break;
        case "PageDown":
          next = this.value - this.step * 4;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      this.commit(next);
    });
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}
