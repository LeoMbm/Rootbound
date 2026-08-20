export function listActiveProjectRescues(store, projectRef) {
  if (!store?.db || typeof projectRef !== "string" || !projectRef) return [];
  const rows = store.db
    .prepare("SELECT rescue_ref FROM rescue_sessions WHERE project_ref=? AND status='active' ORDER BY touched_at DESC")
    .all(projectRef);
  return rows.map((row) => store.getRescueSession(row.rescue_ref)).filter(Boolean);
}

export function replaceActiveProjectRescues(store, projectRef, { exceptRescueRef = null, touchedAt = Date.now() } = {}) {
  if (!store?.db || typeof projectRef !== "string" || !projectRef) return 0;
  if (exceptRescueRef) {
    return store.db
      .prepare("UPDATE rescue_sessions SET status='replaced', touched_at=? WHERE project_ref=? AND status='active' AND rescue_ref<>?")
      .run(touchedAt, projectRef, exceptRescueRef).changes;
  }
  return store.db
    .prepare("UPDATE rescue_sessions SET status='replaced', touched_at=? WHERE project_ref=? AND status='active'")
    .run(touchedAt, projectRef).changes;
}

export function latestProjectEvent(store, projectRef, kind) {
  if (!store?.db || typeof projectRef !== "string" || !projectRef || typeof kind !== "string" || !kind) return null;
  const row = store.db
    .prepare("SELECT event_id, binding_ref, payload_json, created_at FROM events WHERE project_ref=? AND kind=? ORDER BY event_id DESC LIMIT 1")
    .get(projectRef, kind);
  if (!row) return null;
  let payload = {};
  try { payload = JSON.parse(row.payload_json); } catch {}
  return {
    eventId: Number(row.event_id),
    projectRef,
    bindingRef: row.binding_ref ?? null,
    kind,
    createdAt: Number(row.created_at),
    payload,
  };
}
