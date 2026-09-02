import { useNavigate } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";

import BookMenuView from "#/components/BookMenuView";
import { createBookApi, deleteBookApi, renameBookApi } from "#/db-collections/books";
import { activeBookIdAtom, booksAtom } from "#/lib/sheet-store";

export default function BookMenu() {
  const books = useSelector(booksAtom);
  const activeId = useSelector(activeBookIdAtom);
  const navigate = useNavigate();

  const openBook = (bookId: string) => {
    void navigate({ to: "/b/$bookId", params: { bookId } });
  };

  const handleCreate = async () => {
    const book = await createBookApi();
    if (book) openBook(book.id);
  };

  const handleDelete = async (id: string) => {
    if (!(await deleteBookApi(id))) return;
    // the SSE books event refreshes the list either way, but leaving the
    // deleted book on screen until it arrives would render a dead route
    if (id === activeBookIdAtom.get()) {
      const remaining = booksAtom.get().filter((book) => book.id !== id);
      if (remaining[0]) openBook(remaining[0].id);
    }
  };

  return (
    <BookMenuView
      books={books}
      activeId={activeId}
      onOpen={openBook}
      onCreate={() => void handleCreate()}
      onRename={renameBookApi}
      onDelete={(id) => void handleDelete(id)}
    />
  );
}
