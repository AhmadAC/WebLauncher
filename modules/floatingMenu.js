// =========================================================================
// FLOATING CONTROLLER LOGIC (DRAGGABLE & TOUCH-SAFE)
// =========================================================================
export function setupFloatingMenu() {
  const floatingContainer = document.getElementById('floating-menu-container');
  const menuPill = document.getElementById('menu-pill');
  const menuExpanded = document.getElementById('menu-expanded');
  const runtimeIframe = document.getElementById('runtime-iframe');

  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let initialLeft = 0;
  let initialTop = 0;
  let hasMoved = false;

  floatingContainer.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;

    isDragging = true;
    hasMoved = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    const rect = floatingContainer.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    floatingContainer.classList.add('is-dragging');
    if (runtimeIframe) runtimeIframe.style.pointerEvents = 'none';
    floatingContainer.setPointerCapture(e.pointerId);
  });

  floatingContainer.addEventListener('pointermove', (e) => {
    if (!isDragging) return;

    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;

    if (!hasMoved && Math.hypot(dx, dy) > 4) {
      hasMoved = true;
    }

    if (hasMoved) {
      const rect = floatingContainer.getBoundingClientRect();
      let newLeft = initialLeft + dx;
      let newTop = initialTop + dy;

      const margin = 10;
      const maxLeft = window.innerWidth - rect.width - margin;
      const maxTop = window.innerHeight - rect.height - margin;

      newLeft = Math.max(margin, Math.min(newLeft, maxLeft));
      newTop = Math.max(margin, Math.min(newTop, maxTop));

      floatingContainer.style.left = `${newLeft}px`;
      floatingContainer.style.top = `${newTop}px`;
      floatingContainer.style.right = 'auto';
      floatingContainer.style.bottom = 'auto';
    }
  });

  function finishDrag(e) {
    if (!isDragging) return;
    isDragging = false;
    floatingContainer.classList.remove('is-dragging');
    if (runtimeIframe) runtimeIframe.style.pointerEvents = 'auto';

    try { floatingContainer.releasePointerCapture(e.pointerId); } catch (err) {}

    if (!hasMoved) {
      toggleFloatingMenu();
    }
  }

  floatingContainer.addEventListener('pointerup', finishDrag);
  floatingContainer.addEventListener('pointercancel', finishDrag);

  function toggleFloatingMenu() {
    if (menuExpanded.style.display === 'none' || menuExpanded.style.display === '') {
      menuPill.style.display = 'none';
      menuExpanded.style.display = 'flex';

      requestAnimationFrame(() => {
        const rect = floatingContainer.getBoundingClientRect();
        if (rect.right > window.innerWidth - 10) {
          const shift = rect.right - (window.innerWidth - 10);
          floatingContainer.style.left = `${Math.max(10, rect.left - shift)}px`;
        }
        if (rect.bottom > window.innerHeight - 10) {
          const shift = rect.bottom - (window.innerHeight - 10);
          floatingContainer.style.top = `${Math.max(10, rect.top - shift)}px`;
        }
      });
    } else {
      collapseFloatingMenu();
    }
  }
}

export function collapseFloatingMenu() {
  const menuPill = document.getElementById('menu-pill');
  const menuExpanded = document.getElementById('menu-expanded');
  if (menuExpanded) menuExpanded.style.display = 'none';
  if (menuPill) menuPill.style.display = 'flex';
}