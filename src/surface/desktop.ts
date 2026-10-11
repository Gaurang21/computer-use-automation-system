// DesktopSurface: a deliberate stub. It exists to show the seam is real, not
// web-shaped. Each method notes how it maps onto Windows UI Automation (UIA).
// Everything above the Surface interface (resolver, replay, policy, operator
// console) would work unchanged.

import type { TargetSpec } from '../schema/target.js';
import { assertActorMayUse } from './actor.js';
import { resolveTarget } from './resolve.js';
import type {
  ActResult,
  Action,
  Actor,
  Observation,
  Resolution,
  ResolveOptions,
  Surface,
} from './types.js';

export class DesktopSurfaceNotImplemented extends Error {
  constructor(method: string) {
    super(`DesktopSurface.${method} is a design stub; see the comments in src/surface/desktop.ts`);
    this.name = 'DesktopSurfaceNotImplemented';
  }
}

export class DesktopSurface implements Surface {
  readonly kind = 'desktop' as const;

  /**
   * observe(): walk the UIA tree of the target window (IUIAutomation.ElementFromHandle,
   * then a TreeWalker over the ControlView).
   * - role      <- ControlType mapped to the same vocabulary as the web
   *                (Edit -> textbox, Text -> text, Button -> button, Hyperlink -> link,
   *                ComboBox -> combobox, Table/DataGrid -> table, DataItem -> cell)
   * - name      <- Name property (often empty on legacy Win32/VB6 forms, as on legacy web)
   * - value     <- ValuePattern.Value
   * - bbox      <- BoundingRectangle
   * - states    <- IsEnabled, HasKeyboardFocus, TogglePattern state, IsReadOnly
   * - table     <- GridItemPattern.Row / Column
   * - framePath <- the chain of window/pane names (MDI child, tab page) above the element
   * - nearText  <- computeNearText() from ./near-text.ts, unchanged: geometry is geometry
   * - screenshot <- capture of the window rectangle
   */
  async observe(): Promise<Observation> {
    throw new DesktopSurfaceNotImplemented('observe');
  }

  /** Same pure resolver as the web surface, over the UIA-derived element list. */
  async resolve(target: TargetSpec, options?: ResolveOptions): Promise<Resolution> {
    const obs = await this.observe();
    return resolveTarget(obs.elements, target, options);
  }

  /**
   * act():
   * - click   -> InvokePattern.Invoke(), else SendInput mouse click at the bbox centre
   * - type    -> ValuePattern.SetValue() (clears by construction), else focus + SendInput
   * - select  -> ExpandCollapsePattern.Expand() + SelectionItemPattern.Select() on the item by Name
   * - press   -> SendInput virtual key
   * - read    -> ValuePattern.Value or Name
   * - goto    -> launch or focus the application window (no URLs on desktop)
   * - pointer / key (human only) -> SendInput, forwarded from the operator console
   */
  async act(action: Action, actor: Actor): Promise<ActResult> {
    assertActorMayUse(action, actor);
    throw new DesktopSurfaceNotImplemented('act');
  }

  /** location(): process name + window title, e.g. "corebank.exe | Member Inquiry". */
  async location(): Promise<string> {
    throw new DesktopSurfaceNotImplemented('location');
  }

  async screenshot(): Promise<Buffer> {
    throw new DesktopSurfaceNotImplemented('screenshot');
  }

  async close(): Promise<void> {
    // Nothing to release in the stub.
  }
}
