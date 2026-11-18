export function TabPlaceholder({ title }: { title: string }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 p-6 text-sm text-gray-500">
      แท็บ {title} กำลังจะเปิดให้ใช้งานเร็ว ๆ นี้
    </div>
  )
}
