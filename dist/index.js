function filterTable() {
  const searchInput = document.getElementById('searchInput').value.toLowerCase()
  const rows = document.querySelectorAll('table tbody tr')

  rows.forEach(row => {
    const provider = row.cells[0].textContent.toLowerCase()
    const providerId = row.cells[1].textContent.toLowerCase()
    const model = row.cells[2].textContent.toLowerCase()
    const modelId = row.cells[3].textContent.toLowerCase()

    if (provider.includes(searchInput) || model.includes(searchInput) || providerId.includes(searchInput) || modelId.includes(searchInput)) {
      row.style.display = ''
    } else {
      row.style.display = 'none'
    }
  })
}

let currentSort = { column: null, direction: 'asc' }

function sortTable(column) {
  const tbody = document.getElementById('tableBody')
  const rows = Array.from(tbody.querySelectorAll('tr'))
  
  // Determine sort direction
  if (currentSort.column === column) {
    currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc'
  } else {
    currentSort.direction = 'asc'
  }
  currentSort.column = column

  // Sort rows
  rows.sort((a, b) => {
    let aValue, bValue
    
    // Get values based on column
    switch (column) {
      case 'provider':
        aValue = a.dataset.provider
        bValue = b.dataset.provider
        break
      case 'model':
        aValue = a.dataset.model
        bValue = b.dataset.model
        break
      case 'provider-id':
        aValue = a.dataset.providerId
        bValue = b.dataset.providerId
        break
      case 'model-id':
        aValue = a.dataset.modelId
        bValue = b.dataset.modelId
        break
      case 'attachment':
      case 'reasoning':
      case 'temperature':
        aValue = parseInt(a.dataset[column.replace('-', '')])
        bValue = parseInt(b.dataset[column.replace('-', '')])
        break
      case 'input-cost':
        aValue = parseFloat(a.dataset.inputCost)
        bValue = parseFloat(b.dataset.inputCost)
        break
      case 'output-cost':
        aValue = parseFloat(a.dataset.outputCost)
        bValue = parseFloat(b.dataset.outputCost)
        break
      case 'input-cached-cost':
        aValue = parseFloat(a.dataset.inputCachedCost)
        bValue = parseFloat(b.dataset.inputCachedCost)
        break
      case 'output-cached-cost':
        aValue = parseFloat(a.dataset.outputCachedCost)
        bValue = parseFloat(b.dataset.outputCachedCost)
        break
      case 'context-limit':
        aValue = parseInt(a.dataset.contextLimit)
        bValue = parseInt(b.dataset.contextLimit)
        break
      case 'output-limit':
        aValue = parseInt(a.dataset.outputLimit)
        bValue = parseInt(b.dataset.outputLimit)
        break
      default:
        return 0
    }

    // Compare values
    let comparison = 0
    if (typeof aValue === 'string') {
      comparison = aValue.localeCompare(bValue)
    } else {
      comparison = aValue - bValue
    }

    return currentSort.direction === 'asc' ? comparison : -comparison
  })

  // Update table
  rows.forEach(row => tbody.appendChild(row))
  
  // Update sort indicators
  updateSortIndicators()
}

function updateSortIndicators() {
  // Remove all existing sort indicators
  document.querySelectorAll('.sort-arrow').forEach(arrow => {
    arrow.textContent = ''
    arrow.parentElement.classList.remove('sorted-asc', 'sorted-desc')
  })
  
  // Add indicator for current sort
  if (currentSort.column) {
    const header = document.querySelector(`[data-column="${currentSort.column}"]`)
    const arrow = header.querySelector('.sort-arrow')
    arrow.textContent = currentSort.direction === 'asc' ? ' ↑' : ' ↓'
    header.classList.add(`sorted-${currentSort.direction}`)
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const dialog = document.getElementById('howToUse')
  const openBtn = document.getElementById('btnHowToUse')
  const closeBtn = document.getElementById('btnClose')
  let scrollY

  // Add event listeners to sortable headers
  document.querySelectorAll('.sortable').forEach(header => {
    header.addEventListener('click', () => {
      const column = header.dataset.column
      sortTable(column)
    })
  })

  // Initialize with default sort by provider
  sortTable('provider')

  openBtn.addEventListener('click', () => {
    scrollY = window.scrollY
    document.body.style.position = 'fixed'
    document.body.style.top = "-" + scrollY + "px"
    dialog.showModal()
  })

  function closeDialog() {
    dialog.close()
    document.body.style.position = ''
    document.body.style.top = ''
    window.scrollTo(0, scrollY)
  }

  closeBtn.addEventListener('click', closeDialog)
  dialog.addEventListener('cancel', closeDialog)
  dialog.addEventListener('click', e => {
    if (e.target === dialog) closeDialog()
  })
})
