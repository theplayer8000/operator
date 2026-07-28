import { useState } from "react";
import { Server, Plus, RefreshCw } from "lucide-react";
import { useHomelab } from "@/hooks/useHomelab";
import ServiceTile from "@/components/homelab/ServiceTile";
import ServiceForm from "@/components/homelab/ServiceForm";

export default function Homelab() {
  const { services, statuses, checkedAt, checking, online, refresh, addService, updateService, deleteService } =
    useHomelab();

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const editing = services.find((s) => s.id === editingId);

  return (
    <div>
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-badge bg-xp/10 border border-xp/25 flex items-center justify-center text-xp">
            <Server size={18} />
          </div>
          <div>
            <h1 className="font-display text-lg text-ink-100 leading-tight">Homelab</h1>
            <p className="text-xs text-ink-500">
              {services.length} services · {online} online
              {checkedAt && (
                <span className="font-mono">
                  {" "}
                  · checked {new Date(checkedAt).toLocaleTimeString("en-GB")}
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => void refresh()}
            aria-label="Re-check services"
            title="Re-check"
            className="w-11 h-11 rounded-badge border border-base-600 flex items-center justify-center text-ink-500 hover:text-ink-100 hover:border-base-500 transition-colors"
          >
            <RefreshCw size={15} className={checking ? "animate-spin" : ""} />
          </button>
          <button
            onClick={() => {
              setEditingId(null);
              setAdding((v) => !v);
            }}
            className="inline-flex items-center gap-1.5 px-3 min-h-[44px] rounded-badge bg-xp text-base-950 text-sm font-medium hover:bg-xp-bright transition-colors"
          >
            <Plus size={15} /> Add service
          </button>
        </div>
      </div>

      {adding && (
        <ServiceForm
          submitLabel="Add service"
          onSubmit={(value) => {
            addService(value);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      {editing && (
        <ServiceForm
          key={editing.id}
          initial={editing}
          submitLabel="Save changes"
          onSubmit={(value) => {
            updateService(editing.id, value);
            setEditingId(null);
          }}
          onCancel={() => setEditingId(null)}
        />
      )}

      {services.length === 0 ? (
        <p className="text-sm text-ink-700 py-10 text-center">
          Nothing here yet — add the first service running on this box.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {services.map((s) => (
            <ServiceTile
              key={s.id}
              service={s}
              status={statuses[s.id]}
              onEdit={() => {
                setAdding(false);
                setEditingId(s.id);
              }}
              onDelete={() => deleteService(s.id)}
            />
          ))}
        </div>
      )}

      <p className="text-xs text-ink-700 mt-6 leading-relaxed max-w-2xl">
        Status is a TCP connect from the machine running Operator's storage server, so it answers
        "is that port open", not "is the app inside healthy". Removing a tile removes the pointer
        only — it never touches the service or its data.
      </p>
    </div>
  );
}
