const modal = document.getElementById("modal") as HTMLDialogElement;
const help = document.getElementById("help")!;
const close = document.getElementById("close")!;
const search = document.getElementById("search")! as HTMLInputElement;

search.addEventListener("input", () => {
  const value = search.value.toLowerCase();
  const rows = document.querySelectorAll(
    "table tbody tr",
  ) as NodeListOf<HTMLTableRowElement>;

  rows.forEach((row) => {
    const cellTexts = Array.from(row.cells).map((cell) =>
      cell.textContent!.toLowerCase(),
    );
    const isVisible = cellTexts.some((text) => text.includes(value));
    row.style.display = isVisible ? "" : "none";
  });
});

let scrollY = 0;

help.addEventListener("click", () => {
  scrollY = window.scrollY;
  document.body.style.position = "fixed";
  document.body.style.top = `-${scrollY}px`;
  modal.showModal();
});

function closeDialog() {
  modal.close();
  document.body.style.position = "";
  document.body.style.top = "";
  window.scrollTo(0, scrollY);
}

close.addEventListener("click", closeDialog);
modal.addEventListener("cancel", closeDialog);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeDialog();
});
