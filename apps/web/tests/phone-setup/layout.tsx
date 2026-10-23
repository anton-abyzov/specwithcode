import type { ReactNode } from "react";
export function SettingsSection({ children }: { children: ReactNode }) {
  return <section>{children}</section>;
}
export function SettingsRow({
  title,
  description,
  control,
}: {
  title: string;
  description: ReactNode;
  control: ReactNode;
}) {
  return (
    <div className="space-y-4 rounded-xl border p-6">
      <h2>{title}</h2>
      <p>{description}</p>
      {control}
    </div>
  );
}
