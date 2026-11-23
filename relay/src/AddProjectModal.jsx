import React, { useEffect, useId, useRef } from 'react';
import { FolderOpen, FolderPlus, GitBranch, X } from 'lucide-react';

const focusableSelector = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])'
].join(', ');

function ModalButton({ children, icon: Icon, primary, ...props }) {
  return <button type="button" className={'button' + (primary ? ' primary' : '')} {...props}>
    {Icon ? <Icon aria-hidden="true" size={18} /> : null}{children}
  </button>;
}

// The "add project" form in a modal dialog. State and API handlers stay in the projects page;
// this component only renders them, traps focus while open, closes on the close button,
// a backdrop click or Escape, and returns focus to the element that opened it.
export default function AddProjectModal({
  open, onClose, returnFocusRef,
  folder, name, onFolderChange, onNameChange,
  onPick, picking = false, pending = false,
  needsInit, onInit, onUseParent, onCancelInit,
  error, notice, onSubmit
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef(null);
  const folderRef = useRef(null);
  const busy = pending || picking;
  const latest = useRef({ onClose, busy });
  latest.current = { onClose, busy };

  // Remember the opener, move focus into the dialog, and give focus back when it closes or unmounts.
  useEffect(() => {
    if (!open) return;
    const opener = returnFocusRef?.current || document.activeElement;
    const frame = requestAnimationFrame(() => {
      const target = folderRef.current || dialogRef.current?.querySelector(focusableSelector) || dialogRef.current;
      target?.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    };
  }, [open, returnFocusRef]);

  // Escape closes (unless a request or the Windows folder picker is still running); Tab stays inside the dialog.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        if (event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        if (!latest.current.busy) latest.current.onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll(focusableSelector)].filter(item => item.offsetParent !== null || item === document.activeElement);
      if (!items.length) { event.preventDefault(); dialogRef.current.focus(); return; }
      const first = items[0];
      const last = items.at(-1);
      const inside = dialogRef.current.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || !inside)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !inside)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  if (!open) return null;

  const close = () => { if (!busy) onClose(); };
  const onBackdrop = event => { if (event.target === event.currentTarget) close(); };

  return <div className="overlay project-modal-backdrop" onMouseDown={onBackdrop}>
    <form ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}
      aria-busy={busy || undefined} tabIndex={-1} className="card dialog project-modal" onSubmit={onSubmit}>
      <header>
        <h2 id={titleId}>เพิ่มโปรเจกต์</h2>
        <button title="ปิด" aria-label="ปิด" className="icon-button" type="button" onClick={close} disabled={busy}><X size={22} aria-hidden="true" /></button>
      </header>
      <small id={descriptionId}>เพิ่มโฟลเดอร์งานที่มีอยู่แล้ว เพื่อให้ AI เข้าไปทำงานต่อได้</small>
      <div className="add-row">
        <label>โฟลเดอร์ของโปรเจกต์<input ref={folderRef} required value={folder} maxLength={500} placeholder={'D:\\Projects\\my-app'}
          onChange={event => onFolderChange(event.target.value)} /></label>
        <ModalButton icon={FolderOpen} onClick={onPick} disabled={busy}>{picking ? 'รอเลือกโฟลเดอร์…' : 'เลือกโฟลเดอร์'}</ModalButton>
      </div>
      <label>ชื่อที่แสดง (ไม่ใส่ก็ได้)<input value={name} maxLength={80} placeholder="ใช้ชื่อโฟลเดอร์" onChange={event => onNameChange(event.target.value)} /></label>
      {picking ? <p className="muted" role="status">หน้าต่างเลือกโฟลเดอร์ของ Windows เปิดอยู่ ถ้าไม่เห็น ให้ดูที่แถบงาน</p> : null}
      {needsInit ? <div className="init-panel" role="alert">
        <strong>{needsInit.error}</strong>
        {needsInit.kind === 'parent' ? <p>{needsInit.parentUsable ?
          'เลือกได้ว่าจะใช้ repo ที่ใหญ่กว่านั้นทั้งก้อน หรือสร้าง Git repo แยกเฉพาะโฟลเดอร์นี้' :
          'repo นั้นเป็นโฟลเดอร์ผู้ใช้หรือ root ของไดรฟ์ Relay จะไม่ใช้ repo นั้น ให้สร้าง Git repo แยกเฉพาะโฟลเดอร์นี้แทน'}</p> : null}
        <p>Relay ต้องใช้ Git repo ที่มี commit อย่างน้อย 1 ครั้ง ปุ่มสร้างจะ{needsInit.kind === 'empty' ? '' : 'สร้าง Git repo ในโฟลเดอร์นี้ แล้ว '}commit ไฟล์ทั้งหมดในโฟลเดอร์ ({needsInit.entries} รายการที่ระดับบนสุด) เป็น commit แรก</p>
        <p>{needsInit.hasGitignore ? 'ไฟล์ที่อยู่ใน .gitignore จะไม่ถูก commit' : 'โฟลเดอร์นี้ยังไม่มี .gitignore Relay จะสร้างให้ เพื่อไม่ให้ commit node_modules, dist และไฟล์ลับอย่าง .env หรือ *.key'}</p>
        <div className="action-row">
          <ModalButton primary icon={FolderPlus} onClick={onInit} disabled={pending}>{needsInit.kind === 'empty' ? 'สร้าง commit แรก' : 'สร้าง Git repo และ commit แรก'}</ModalButton>
          {needsInit.parentUsable ? <ModalButton icon={GitBranch} onClick={onUseParent} disabled={pending}>ใช้ repo ที่ใหญ่กว่า</ModalButton> : null}
          <ModalButton onClick={onCancelInit} disabled={pending}>ยกเลิก</ModalButton>
        </div>
      </div> : null}
      {error ? <p role="alert" className="error">{error}</p> : null}
      {notice ? <p role="status" className="success">{notice}</p> : null}
      <footer>
        <ModalButton onClick={close} disabled={busy}>ปิด</ModalButton>
        <button type="submit" className="button primary" disabled={pending || !folder.trim()}>
          <FolderPlus size={18} aria-hidden="true" />{pending ? 'กำลังเพิ่ม…' : 'เพิ่มโปรเจกต์'}
        </button>
      </footer>
    </form>
  </div>;
}
