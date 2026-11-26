// One status badge per job that says what the user needs to do next.
// Display only: it never changes the status stored by the server.

export const statusLabels = {
  queued: 'รอเริ่ม', running: 'กำลังดำเนินการ', stopping: 'กำลังหยุด', complete: 'พร้อมตรวจผล',
  needs_review: 'ต้องตรวจเพิ่ม', failed: 'งานติดขัด', cancelled: 'หยุดแล้ว', interrupted: 'ถูกขัดจังหวะ', waiting_approval: 'รออนุมัติ'
};

// Returns { status, label }: `status` is the CSS modifier for the .status class.
export function getJobStatusBadge(job) {
  const status = job?.status;
  const merged = Boolean(job?.merged);
  if (status === 'waiting_approval') {
    return { status, label: job?.approval?.kind === 'before_merge' ? 'รออนุมัติ merge' : statusLabels.waiting_approval };
  }
  if (merged && (status === 'complete' || status === 'needs_review')) {
    return status === 'needs_review'
      ? { status, label: 'merge แล้ว · ยังมีปัญหาค้าง' }
      : { status: 'merged', label: 'merge แล้ว' };
  }
  return { status, label: statusLabels[status] || status || 'ยังไม่มีสถานะ' };
}
