CREATE VIRTUAL TABLE entries_fts USING fts5(
  title, summary, takeaway, tags, content_markdown,
  content='entries', content_rowid='rowid'
);
--> statement-breakpoint
CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, summary, takeaway, tags, content_markdown)
  VALUES (new.rowid, new.title, new.summary, new.takeaway, new.tags, new.content_markdown);
END;
--> statement-breakpoint
CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, summary, takeaway, tags, content_markdown)
  VALUES ('delete', old.rowid, old.title, old.summary, old.takeaway, old.tags, old.content_markdown);
END;
--> statement-breakpoint
CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, summary, takeaway, tags, content_markdown)
  VALUES ('delete', old.rowid, old.title, old.summary, old.takeaway, old.tags, old.content_markdown);
  INSERT INTO entries_fts(rowid, title, summary, takeaway, tags, content_markdown)
  VALUES (new.rowid, new.title, new.summary, new.takeaway, new.tags, new.content_markdown);
END;
