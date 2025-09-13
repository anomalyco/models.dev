// Selection and Filter Logic for Models Table
export function initializeSelection() {
  const rowCheckboxes = () => Array.from(document.querySelectorAll('.row-checkbox')) as HTMLInputElement[];
  const selectAll = document.getElementById('select-all') as HTMLInputElement;
  const filterBtn = document.getElementById('filter-selected') as HTMLButtonElement;
  const selected = new Set<string>();
  let filterActive = false;

  // Helper: get row key
  function getRowKey(tr: HTMLTableRowElement): string {
    return tr.getAttribute('data-provider-id') + '::' + tr.getAttribute('data-model-id')!;
  }

  // Update selection state and UI
  function updateSelectionUI() {
    rowCheckboxes().forEach(cb => {
      const tr = cb.closest('tr') as HTMLTableRowElement;
      const key = getRowKey(tr);
      if (selected.has(key)) {
        cb.checked = true;
        tr.classList.add('selected-row');
      } else {
        cb.checked = false;
        tr.classList.remove('selected-row');
      }
    });
    // Update select-all
    if (selected.size === 0) {
      selectAll.checked = false;
      selectAll.indeterminate = false;
    } else if (selected.size === rowCheckboxes().length) {
      selectAll.checked = true;
      selectAll.indeterminate = false;
    } else {
      selectAll.checked = false;
      selectAll.indeterminate = true;
    }
    selectAll.disabled = filterActive;
    // Update filter button
    filterBtn.disabled = selectAll.checked;
    filterBtn.textContent = filterActive ? 'Show All' : 'Show Selected Only';
  }

  // Row checkbox click
  document.addEventListener('change', function (e) {
    const target = e.target as HTMLInputElement;
    if (target.classList.contains('row-checkbox')) {
      const tr = target.closest('tr') as HTMLTableRowElement;
      const key = getRowKey(tr);
      if (target.checked) {
        selected.add(key);
      } else {
        selected.delete(key);
      }
      updateSelectionUI();
      if (filterActive) applyFilter();
    }
  });

  // Select all checkbox
  selectAll.addEventListener('change', function (e) {
    if (selectAll.checked) {
      rowCheckboxes().forEach(cb => {
        const tr = cb.closest('tr') as HTMLTableRowElement;
        selected.add(getRowKey(tr));
      });
    } else {
      selected.clear();
    }
    updateSelectionUI();
    if (filterActive) applyFilter();
  });

  // Filter button
  filterBtn.addEventListener('click', function () {
    filterActive = !filterActive;
    applyFilter();
    updateSelectionUI();
  });

  function applyFilter() {
    rowCheckboxes().forEach(cb => {
      const tr = cb.closest('tr') as HTMLTableRowElement;
      const key = getRowKey(tr);
      if (filterActive) {
        tr.style.display = selected.has(key) ? '' : 'none';
      } else {
        tr.style.display = '';
      }
    });
  }

  // Keyboard accessibility: space/enter on row
  document.addEventListener('keydown', function (e) {
    if ((e.key === ' ' || e.key === 'Enter') && (document.activeElement as HTMLElement)?.classList.contains('row-checkbox')) {
      e.preventDefault();
      (document.activeElement as HTMLInputElement).click();
    }
  });

  // Initial UI update
  updateSelectionUI();
}
