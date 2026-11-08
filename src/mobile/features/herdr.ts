/** Lifecycle routes only; mounted beneath the existing /mobile auth guard by the host. */
import { LifecycleError, type Binding, type Lifecycle, type Receipt } from '../herdr/lifecycle';

export interface HerdrFeatureOptions {
  lifecycle: Lifecycle;
  /** Fresh lookup: never resolve client-supplied generation from cached display capabilities. */
  resolve?: (ws: string, room: string, generation: string) => Promise<Binding>;
  deliveryStatus?: (id: string, ws: string, room: string, generation: string) => Promise<Receipt> | Receipt;
}
let configured: HerdrFeatureOptions | undefined;
/** Host calls this after wiring production ports and disabling the legacy autostart writer/boot path. */
export function configureHerdrFeature(options: HerdrFeatureOptions): void { configured = options; }
const validText = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 160;

export function mount(app: any, injected?: HerdrFeatureOptions): void {
  const use = () => injected ?? configured ?? (() => { throw new LifecycleError('lifecycle_unavailable', 503); })();
  const handler = (fn: (ctx: any, deps: HerdrFeatureOptions) => any) => async (ctx: any = {}) => {
    ctx.set ??= {}; ctx.set.headers ??= {};
    ctx.set.headers['cache-control'] = 'no-store, private';
    try { return await fn(ctx, use()); }
    catch (e: any) {
      ctx.set.status = e instanceof LifecycleError || (typeof e?.code === 'string' && Number.isInteger(e?.status)) ? e.status : 503;
      return { ok: false, code: typeof e?.code === 'string' && /^[a-z_]+$/.test(e.code) ? e.code : 'lifecycle_unavailable', error: 'ดำเนินการ Herdr ไม่สำเร็จ กรุณาตรวจสถานะล่าสุด' };
    }
  };
  app.get('/herdr/status', handler((_ctx, { lifecycle }) => ({ ok: true, operations: lifecycle.list(), readiness: lifecycle.readiness })));
  app.post('/herdr/create', handler(async ({ body }, { lifecycle }) => ({ ok: true, operation: await lifecycle.create(body) })));
  app.get('/herdr/operations/:id', handler(({ params }, { lifecycle }) => ({ ok: true, operation: lifecycle.status(params.id) })));
  app.get('/herdr/operations/:id/rules', handler(({ params, set }, { lifecycle }) => { set.headers['content-type'] = 'text/markdown; charset=utf-8'; return lifecycle.rulesMarkdown(params.id); }));
  app.post('/herdr/operations/:id/continue', handler(async ({ params }, { lifecycle }) => ({ ok: true, operation: await lifecycle.continueOperation(params.id) })));
  app.post('/herdr/operations/:id/autostart', handler(({ params, body }, { lifecycle }) => {
    if (typeof body?.on !== 'boolean' || (body.memberId !== undefined && !validText(body.memberId))) throw new LifecycleError('invalid_autostart', 400);
    return { ok: true, operation: lifecycle.setAutostart(params.id, body.on, body.memberId) };
  }));
  app.post('/herdr/close/preview', handler(async ({ body }, { lifecycle }) => {
    if (!validText(body?.workspaceId) || (body.paneId !== undefined && !validText(body.paneId))) throw new LifecycleError('invalid_close_target', 400);
    return { ok: true, preview: await lifecycle.closePreview({ workspaceId: body.workspaceId, ...(body.paneId ? { paneId: body.paneId } : {}) }) };
  }));
  app.get('/herdr/close/:id', handler(async ({ params }, { lifecycle }) => ({ ok: true, close: await lifecycle.closeStatus(params.id) })));
  app.post('/herdr/close/confirm', handler(async ({ body }, { lifecycle }) => {
    if (!validText(body?.previewId)) throw new LifecycleError('invalid_confirmation', 400);
    return { ok: true, close: await lifecycle.closeConfirm(body.previewId) };
  }));
  app.post('/herdr/stop', handler(async ({ body }, deps) => {
    if (!deps.resolve || !validText(body?.ws) || !validText(body?.room) || !validText(body?.generation) || !validText(body?.id)) throw new LifecycleError('invalid_stop', 400);
    const target = await deps.resolve(body.ws, body.room, body.generation);
    return { ok: true, delivery: await deps.lifecycle.stop(target, body.id, target.instanceId ?? '') };
  }));
  app.get('/herdr/delivery/:id', handler(async ({ params, query }, deps) => {
    if (!deps.deliveryStatus) throw new LifecycleError('delivery_unavailable', 503);
    if (!validText(params?.id) || !validText(query?.ws) || !validText(query?.room) || !validText(query?.generation)) throw new LifecycleError('delivery_scope_required', 400);
    return { ok: true, delivery: await deps.deliveryStatus(params.id, query.ws, query.room, query.generation) };
  }));
}
