import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { ArrowLeft, Check, ChevronDown, Zap } from "lucide-react";
import { Slider } from "radix-ui";
import type { ComposerProps } from "./Composer.tsx";
import { FloatingMenu, type AnchorRect } from "./FloatingMenu.tsx";
import { t, thinkingLevelLabel } from "../lib/i18n.ts";
import { groupModelsByProvider } from "../lib/model-groups.ts";
import { modelSupportsThinking } from "../lib/thinking-levels.ts";
import type { ServiceTierId } from "../lib/service-tier.ts";

type ModelSettings = Pick<
  ComposerProps,
  | "locale"
  | "running"
  | "modelOptions"
  | "modelValue"
  | "onModelChange"
  | "thinkingLevel"
  | "thinkingLevels"
  | "onThinkingChange"
  | "serviceTier"
  | "serviceTiers"
  | "onServiceTierChange"
>;

type PickerProps = ModelSettings & {
  open: boolean;
  anchor: AnchorRect | null;
  onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
  onClose: () => void;
};

function modelName(props: ModelSettings): string {
  const model = props.modelOptions.find(
    (option) => `${option.provider}/${option.id}` === props.modelValue,
  );
  return (
    model?.name ||
    model?.id ||
    props.modelValue.slice(props.modelValue.indexOf("/") + 1) ||
    t(props.locale, "composer.model.none")
  );
}

export function ComposerModelPicker(props: PickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const label = modelName(props);
  const thinkingSupported = modelSupportsThinking(props.thinkingLevels);
  const effort = thinkingLevelLabel(props.locale, props.thinkingLevel);
  const open = props.open && !props.running;

  function close() {
    props.onClose();
    triggerRef.current?.focus({ preventScroll: true });
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="model-select-wrap"
        className="composer-model-trigger"
        title={thinkingSupported ? `${label} · ${effort}` : label}
        aria-label={`${t(props.locale, "composer.model.select")}: ${label}${thinkingSupported ? `, ${effort}` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={props.running}
        onClick={props.onToggle}
      >
        <span className="min-w-0 truncate" data-testid="model-select-label">
          {label}
        </span>
        {thinkingSupported && (
          <span
            className="composer-model-effort"
            data-max={props.thinkingLevel === "max" || undefined}
            data-testid="model-thinking-label"
          >
            {effort}
          </span>
        )}
        <ChevronDown
          className="composer-model-trigger-chevron size-3 shrink-0"
          strokeWidth={1.75}
          aria-hidden
        />
      </button>
      <FloatingMenu
        open={open}
        anchor={props.anchor}
        onClose={close}
        triggerRef={triggerRef}
        placement="top"
        align="end"
        surface="custom"
        role="dialog"
        ariaLabel={t(props.locale, "composer.model.settings")}
        testId="composer-model-menu"
        minWidth={0}
        className="composer-model-picker !overflow-hidden !p-1"
      >
        <PickerPanel {...props} id={id} onClose={close} />
      </FloatingMenu>
    </>
  );
}

function PickerPanel(props: ModelSettings & { id: string; onClose: () => void }) {
  const tr = (key: Parameters<typeof t>[1]) => t(props.locale, key);
  const [view, setView] = useState<"effort" | "models" | "speed">(
    props.modelValue ? "effort" : "models",
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const modelLabel = modelName(props);
  const groups = useMemo(
    () => groupModelsByProvider(props.modelOptions, t(props.locale, "models.group.custom")),
    [props.modelOptions, props.locale],
  );
  const thinkingSupported = modelSupportsThinking(props.thinkingLevels);
  const [draft, setDraft] = useState<{ source: string; index: number } | null>(null);
  const source = `${props.modelValue}:${props.thinkingLevel}:${props.thinkingLevels.join(",")}`;
  const index =
    draft?.source === source
      ? draft.index
      : Math.max(0, props.thinkingLevels.indexOf(props.thinkingLevel));
  const level = props.thinkingLevels[index] ?? props.thinkingLevel;
  const effort = thinkingLevelLabel(props.locale, level);
  const progress = index / Math.max(1, props.thinkingLevels.length - 1);
  // Keep the fill joined to the thumb, including its inset at intermediate stops.
  const fillOffset = progress === 0 || progress === 1 ? 0 : 14 - progress * 28;

  // Each view has a deliberate keyboard entry point; selecting a model returns to effort.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const target =
      view === "effort"
        ? panel?.querySelector<HTMLElement>("[data-model-view-toggle]")
        : (panel?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ??
          panel?.querySelector<HTMLElement>('[role="menuitemradio"]'));
    (target ?? panel?.querySelector<HTMLButtonElement>("button"))?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest" });
  }, [view]);

  function handleKeys(event: KeyboardEvent<HTMLDivElement>) {
    const panel = panelRef.current;
    if (!panel) return;
    if (event.key === "Tab") {
      const controls = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [role="slider"]:not([aria-disabled="true"])',
        ),
      );
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    if (view === "effort") {
      if (
        event.key === "Enter" &&
        (event.target as HTMLElement).getAttribute("role") === "slider"
      ) {
        event.preventDefault();
        props.onClose();
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setView("effort");
      return;
    }
    const items = Array.from(panel.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  function tierLabel(tier: ServiceTierId) {
    return tr(`composer.speed.${tier}`);
  }

  return (
    <div
      id={props.id}
      ref={panelRef}
      className="composer-model-picker-panel"
      onKeyDown={handleKeys}
    >
      {view === "effort" ? (
        <div className="composer-model-simple">
          <div className="composer-model-view-controls">
            <button
              type="button"
              data-model-view-toggle
              data-testid="composer-model-list-trigger"
              className="composer-model-view-toggle"
              aria-label={`${tr("composer.model.select")}: ${modelLabel}`}
              onClick={() => setView("models")}
            >
              <span className="composer-model-view-content">
                {thinkingSupported ? (
                  <>
                    <span className="composer-model-view-heading">
                      <span
                        className="composer-model-current-effort"
                        data-max={level === "max" || undefined}
                      >
                        {effort}
                      </span>
                      <ChevronDown size={14} aria-hidden />
                    </span>
                    <span className="composer-model-current-name" title={modelLabel}>
                      {modelLabel}
                    </span>
                  </>
                ) : (
                  <span className="composer-model-view-heading">
                    <span className="truncate">{modelLabel}</span>
                    <ChevronDown size={14} aria-hidden />
                  </span>
                )}
              </span>
            </button>
            {props.serviceTiers.length > 0 && (
              <button
                type="button"
                className="composer-model-speed-toggle"
                data-testid="composer-speed-trigger"
                data-priority={props.serviceTier === "priority" || undefined}
                title={`${tr("composer.model.speed")}: ${tierLabel(props.serviceTier)}`}
                aria-label={`${tr("composer.model.speed")}: ${tierLabel(props.serviceTier)}`}
                onClick={() => setView("speed")}
              >
                <Zap size={16} strokeWidth={1.75} aria-hidden />
              </button>
            )}
          </div>
          {thinkingSupported ? (
            <div className="composer-model-slider-wrap">
              <Slider.Root
                className="composer-model-slider"
                min={0}
                max={Math.max(1, props.thinkingLevels.length - 1)}
                step={1}
                value={[index]}
                disabled={props.thinkingLevels.length < 2}
                onValueChange={([value]) => {
                  if (value != null) setDraft({ source, index: value });
                }}
                onValueCommit={([value]) => {
                  const selected = value == null ? undefined : props.thinkingLevels[value];
                  if (selected && selected !== props.thinkingLevel)
                    props.onThinkingChange(selected);
                }}
                data-max={level === "max" || undefined}
              >
                <Slider.Track className="composer-model-slider-track">
                  <Slider.Range
                    className="composer-model-slider-range"
                    style={{ right: "auto", width: `calc(${progress * 100}% + ${fillOffset}px)` }}
                  />
                  <span className="composer-model-slider-ticks" aria-hidden>
                    {props.thinkingLevels.map((item, position) => {
                      const fraction = position / Math.max(1, props.thinkingLevels.length - 1);
                      return (
                        <span
                          key={item}
                          data-selected={position <= index}
                          style={{ left: `calc(${fraction * 100}% + ${14 - fraction * 28}px)` }}
                        />
                      );
                    })}
                  </span>
                </Slider.Track>
                <Slider.Thumb
                  className="composer-model-slider-thumb"
                  aria-label={tr("composer.model.thinking")}
                  aria-valuetext={effort}
                />
              </Slider.Root>
            </div>
          ) : (
            <p className="composer-model-unavailable">{tr("composer.model.noThinking")}</p>
          )}
        </div>
      ) : (
        <>
          <div className="composer-model-list-heading">
            <button
              type="button"
              className="composer-model-back"
              aria-label={tr("composer.model.back")}
              onClick={() => setView("effort")}
            >
              <ArrowLeft size={15} aria-hidden />
            </button>
            <span>{tr(view === "models" ? "composer.model.select" : "composer.model.speed")}</span>
          </div>
          <div
            className="composer-model-options pix-scroll"
            role="menu"
            aria-label={tr(view === "models" ? "composer.model.select" : "composer.model.speed")}
          >
            {view === "models" ? (
              groups.length ? (
                groups.map((group) => (
                  <div
                    key={group.key}
                    role="group"
                    aria-label={group.label}
                    className="composer-model-group"
                    data-testid={`composer-model-group-${group.key}`}
                  >
                    {groups.length > 1 && (
                      <div className="composer-model-group-label">{group.label}</div>
                    )}
                    {group.models.map((model) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={props.modelValue === `${model.provider}/${model.id}`}
                        className="composer-model-option"
                        key={`${model.provider}/${model.id}`}
                        data-testid={`composer-model-${model.id}`}
                        title={model.name || model.id}
                        onClick={() => {
                          props.onModelChange(model.provider, model.id);
                          setDraft(null);
                          setView("effort");
                        }}
                      >
                        <span className="min-w-0 truncate">{model.name || model.id}</span>
                        {props.modelValue === `${model.provider}/${model.id}` && (
                          <Check size={16} strokeWidth={1.75} aria-hidden />
                        )}
                      </button>
                    ))}
                  </div>
                ))
              ) : (
                <p className="composer-model-unavailable">{tr("composer.model.none")}</p>
              )
            ) : (
              props.serviceTiers.map((tier) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={props.serviceTier === tier}
                  className="composer-model-option"
                  key={tier}
                  data-testid={`composer-speed-${tier}`}
                  onClick={() => {
                    props.onServiceTierChange(tier);
                    setView("effort");
                  }}
                >
                  <span>{tierLabel(tier)}</span>
                  {props.serviceTier === tier && <Check size={16} strokeWidth={1.75} aria-hidden />}
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
