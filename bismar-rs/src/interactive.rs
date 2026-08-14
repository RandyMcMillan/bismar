//! Interactive vim-like file navigator.
//! Maps bismar's src/interactive.ts.

use crate::diff::walk_files;
use crate::env::{progress_off, progress_reset};
use crossterm::{
    cursor,
    event::{self, Event, KeyCode, KeyEvent},
    execute,
    terminal::{self},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    style::{Color as TuiColor, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap},
    Frame, Terminal,
};
use std::{
    fs,
    io::{self},
    path::PathBuf,
};

// ── State ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum Pane {
    Files,
    Content,
}

struct App {
    /// Root directory being browsed.
    root: PathBuf,
    label: String,
    /// All files (path → bytes), sorted.
    all_files: Vec<(String, u64)>,
    /// Currently filtered + displayed files.
    filtered: Vec<(String, u64)>,
    /// Index into `filtered`.
    file_cursor: usize,
    /// Vertical scroll offset inside the content pane.
    content_scroll: usize,
    /// Active pane.
    pane: Pane,
    /// Search / filter string.
    search: String,
    search_mode: bool,
    /// Content of currently viewed file.
    content: Vec<String>,
    /// File list scroll state for ratatui.
    list_state: ListState,
    /// Message shown in status bar.
    status: String,
    /// Whether to quit.
    quit: bool,
}

impl App {
    fn new(root: PathBuf, label: String) -> Self {
        let files = walk_files(&root);
        let mut sorted: Vec<(String, u64)> = files.into_iter().collect();
        sorted.sort_by(|a, b| a.0.cmp(&b.0));
        let filtered = sorted.clone();
        let mut list_state = ListState::default();
        list_state.select(if filtered.is_empty() { None } else { Some(0) });
        let mut app = App {
            root,
            label,
            all_files: sorted,
            filtered,
            file_cursor: 0,
            content_scroll: 0,
            pane: Pane::Files,
            search: String::new(),
            search_mode: false,
            content: Vec::new(),
            list_state,
            status: String::from("j/k navigate · / search · Enter open · q quit"),
            quit: false,
        };
        app.load_current_file();
        app
    }

    fn load_current_file(&mut self) {
        if let Some((path, _)) = self.filtered.get(self.file_cursor) {
            let full = self.root.join(path);
            self.content = match fs::read(&full) {
                Ok(bytes) => {
                    if is_binary(&bytes) {
                        vec![format!("<binary file: {} bytes>", bytes.len())]
                    } else {
                        String::from_utf8_lossy(&bytes)
                            .lines()
                            .map(|l| l.to_string())
                            .collect()
                    }
                }
                Err(e) => vec![format!("<error reading file: {}>", e)],
            };
            self.content_scroll = 0;
        } else {
            self.content = Vec::new();
        }
    }

    fn apply_filter(&mut self) {
        let q = self.search.to_lowercase();
        self.filtered = if q.is_empty() {
            self.all_files.clone()
        } else {
            self.all_files
                .iter()
                .filter(|(p, _)| p.to_lowercase().contains(&q))
                .cloned()
                .collect()
        };
        self.file_cursor = 0;
        if self.filtered.is_empty() {
            self.list_state.select(None);
        } else {
            self.list_state.select(Some(0));
        }
        self.load_current_file();
    }

    fn handle_key(&mut self, key: KeyEvent) {
        if self.search_mode {
            match key.code {
                KeyCode::Esc => {
                    self.search_mode = false;
                    self.status = "j/k navigate · / search · Enter open · q quit".to_string();
                }
                KeyCode::Enter => {
                    self.search_mode = false;
                    self.status = format!("filter: {} ({} files)", self.search, self.filtered.len());
                }
                KeyCode::Backspace => {
                    self.search.pop();
                    self.apply_filter();
                }
                KeyCode::Char(c) => {
                    self.search.push(c);
                    self.apply_filter();
                }
                _ => {}
            }
            return;
        }

        match self.pane {
            Pane::Files => match key.code {
                KeyCode::Char('q') | KeyCode::Char('Q') => self.quit = true,
                KeyCode::Char('/') => {
                    self.search_mode = true;
                    self.search.clear();
                    self.status = "search: (type to filter)".to_string();
                }
                KeyCode::Char('j') | KeyCode::Down => {
                    if !self.filtered.is_empty() && self.file_cursor + 1 < self.filtered.len() {
                        self.file_cursor += 1;
                        self.list_state.select(Some(self.file_cursor));
                        self.load_current_file();
                    }
                }
                KeyCode::Char('k') | KeyCode::Up => {
                    if self.file_cursor > 0 {
                        self.file_cursor -= 1;
                        self.list_state.select(Some(self.file_cursor));
                        self.load_current_file();
                    }
                }
                KeyCode::Char('g') => {
                    self.file_cursor = 0;
                    self.list_state.select(Some(0));
                    self.load_current_file();
                }
                KeyCode::Char('G') => {
                    if !self.filtered.is_empty() {
                        self.file_cursor = self.filtered.len() - 1;
                        self.list_state.select(Some(self.file_cursor));
                        self.load_current_file();
                    }
                }
                KeyCode::Enter | KeyCode::Char('l') | KeyCode::Right => {
                    self.pane = Pane::Content;
                    self.status = "h/l switch panes · j/k scroll · q quit".to_string();
                }
                KeyCode::Char('u') => {
                    let step = 10;
                    if self.file_cursor >= step { self.file_cursor -= step; }
                    else { self.file_cursor = 0; }
                    self.list_state.select(Some(self.file_cursor));
                    self.load_current_file();
                }
                KeyCode::Char('d') => {
                    let step = 10;
                    let max = self.filtered.len().saturating_sub(1);
                    self.file_cursor = (self.file_cursor + step).min(max);
                    self.list_state.select(Some(self.file_cursor));
                    self.load_current_file();
                }
                _ => {}
            },
            Pane::Content => match key.code {
                KeyCode::Char('q') | KeyCode::Char('Q') => self.quit = true,
                KeyCode::Char('h') | KeyCode::Left => {
                    self.pane = Pane::Files;
                    self.status = "j/k navigate · / search · Enter open · q quit".to_string();
                }
                KeyCode::Char('j') | KeyCode::Down => {
                    let max = self.content.len().saturating_sub(1);
                    self.content_scroll = (self.content_scroll + 1).min(max);
                }
                KeyCode::Char('k') | KeyCode::Up => {
                    self.content_scroll = self.content_scroll.saturating_sub(1);
                }
                KeyCode::Char('u') | KeyCode::PageUp => {
                    self.content_scroll = self.content_scroll.saturating_sub(20);
                }
                KeyCode::Char('d') | KeyCode::PageDown => {
                    let max = self.content.len().saturating_sub(1);
                    self.content_scroll = (self.content_scroll + 20).min(max);
                }
                KeyCode::Char('g') => { self.content_scroll = 0; }
                KeyCode::Char('G') => {
                    self.content_scroll = self.content.len().saturating_sub(1);
                }
                _ => {}
            },
        }
    }
}

fn is_binary(bytes: &[u8]) -> bool {
    // Heuristic: if NUL bytes appear in first 8KB, treat as binary.
    let sample = &bytes[..bytes.len().min(8192)];
    sample.contains(&0)
}

// ── UI rendering ──────────────────────────────────────────────────────────────

fn ui(f: &mut Frame, app: &mut App) {
    let size = f.area();

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(3),
            Constraint::Length(1),
        ])
        .split(size);

    let main_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(30),
            Constraint::Percentage(70),
        ])
        .split(chunks[0]);

    // File list
    let file_items: Vec<ListItem> = app
        .filtered
        .iter()
        .map(|(path, bytes)| {
            let label = format!("{:>8}  {}", crate::public::kb(*bytes), path);
            ListItem::new(label)
        })
        .collect();

    let file_list_style = if app.pane == Pane::Files {
        Style::default().fg(TuiColor::Cyan)
    } else {
        Style::default()
    };
    let file_list = List::new(file_items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(file_list_style)
                .title(format!(" {} ", app.label)),
        )
        .highlight_style(Style::default().add_modifier(Modifier::REVERSED))
        .highlight_symbol("▶ ");

    f.render_stateful_widget(file_list, main_chunks[0], &mut app.list_state);

    // Content pane
    let current_file = app
        .filtered
        .get(app.file_cursor)
        .map(|(p, _)| p.as_str())
        .unwrap_or("");
    let content_lines: Vec<Line> = app
        .content
        .iter()
        .skip(app.content_scroll)
        .take(main_chunks[1].height as usize)
        .map(|line| Line::from(Span::raw(line.as_str())))
        .collect();
    let content_style = if app.pane == Pane::Content {
        Style::default().fg(TuiColor::Cyan)
    } else {
        Style::default()
    };
    let content_widget = Paragraph::new(content_lines)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(content_style)
                .title(format!(" {} ", current_file)),
        )
        .wrap(Wrap { trim: false });
    f.render_widget(content_widget, main_chunks[1]);

    // Status bar
    let status_text = if app.search_mode {
        format!("/{}", app.search)
    } else {
        app.status.clone()
    };
    let status = Paragraph::new(status_text)
        .style(Style::default().fg(TuiColor::Gray));
    f.render_widget(status, chunks[1]);
}

// ── Entry point ───────────────────────────────────────────────────────────────

/// Run the interactive navigator on `root`.
pub fn run_interactive(root: PathBuf, label: String) -> anyhow::Result<()> {
    progress_off();

    terminal::enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, terminal::EnterAlternateScreen, cursor::Hide)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = App::new(root, label);

    loop {
        terminal.draw(|f| ui(f, &mut app))?;

        if event::poll(std::time::Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                app.handle_key(key);
            }
        }

        if app.quit {
            break;
        }
    }

    terminal::disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        terminal::LeaveAlternateScreen,
        cursor::Show
    )?;

    progress_reset();
    Ok(())
}

// ── Diff interactive mode ─────────────────────────────────────────────────────

struct DiffApp {
    a_root: PathBuf,
    b_root: PathBuf,
    a_label: String,
    b_label: String,
    entries: Vec<crate::diff::DiffEntry>,
    cursor: usize,
    content: Vec<String>,
    content_scroll: usize,
    list_state: ListState,
    status: String,
    quit: bool,
}

impl DiffApp {
    fn new(
        a_root: PathBuf,
        b_root: PathBuf,
        a_label: String,
        b_label: String,
        entries: Vec<crate::diff::DiffEntry>,
    ) -> Self {
        let mut list_state = ListState::default();
        if !entries.is_empty() { list_state.select(Some(0)); }
        let mut app = DiffApp {
            a_root,
            b_root,
            a_label,
            b_label,
            entries,
            cursor: 0,
            content: vec![],
            content_scroll: 0,
            list_state,
            status: "j/k navigate · q quit".to_string(),
            quit: false,
        };
        app.load_entry();
        app
    }

    fn load_entry(&mut self) {
        let Some(entry) = self.entries.get(self.cursor) else {
            self.content = vec![];
            return;
        };
        use crate::diff::{render_text_unified_highlighted, DiffStatus};
        let a_path = self.a_root.join(&entry.path);
        let b_path = self.b_root.join(&entry.path);
        let content = match entry.status {
            DiffStatus::Added => {
                let text = fs::read_to_string(&b_path).unwrap_or_default();
                text.lines().map(|l| format!("+ {}", l)).collect()
            }
            DiffStatus::Removed => {
                let text = fs::read_to_string(&a_path).unwrap_or_default();
                text.lines().map(|l| format!("- {}", l)).collect()
            }
            DiffStatus::Modified => {
                let a = fs::read_to_string(&a_path).unwrap_or_default();
                let b = fs::read_to_string(&b_path).unwrap_or_default();
                let rendered = render_text_unified_highlighted(&entry.path, &a, &b, false);
                rendered.lines().map(|l| l.to_string()).collect()
            }
        };
        self.content = content;
        self.content_scroll = 0;
    }

    fn handle_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Char('q') => self.quit = true,
            KeyCode::Char('j') | KeyCode::Down => {
                if self.cursor + 1 < self.entries.len() {
                    self.cursor += 1;
                    self.list_state.select(Some(self.cursor));
                    self.load_entry();
                }
            }
            KeyCode::Char('k') | KeyCode::Up => {
                if self.cursor > 0 {
                    self.cursor -= 1;
                    self.list_state.select(Some(self.cursor));
                    self.load_entry();
                }
            }
            KeyCode::Char('d') | KeyCode::PageDown => {
                let max = self.content.len().saturating_sub(1);
                self.content_scroll = (self.content_scroll + 20).min(max);
            }
            KeyCode::Char('u') | KeyCode::PageUp => {
                self.content_scroll = self.content_scroll.saturating_sub(20);
            }
            _ => {}
        }
    }
}

fn diff_ui(f: &mut Frame, app: &mut DiffApp) {
    let size = f.area();
    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(30), Constraint::Percentage(70)])
        .split(size);

    use crate::diff::DiffStatus;
    let items: Vec<ListItem> = app
        .entries
        .iter()
        .map(|e| {
            let prefix = match e.status {
                DiffStatus::Added => "+",
                DiffStatus::Removed => "-",
                DiffStatus::Modified => "~",
            };
            ListItem::new(format!("{} {}", prefix, e.path))
        })
        .collect();

    let list = List::new(items)
        .block(Block::default().borders(Borders::ALL).title(" changed files "))
        .highlight_style(Style::default().add_modifier(Modifier::REVERSED));
    f.render_stateful_widget(list, chunks[0], &mut app.list_state);

    let content_lines: Vec<Line> = app
        .content
        .iter()
        .skip(app.content_scroll)
        .take(chunks[1].height as usize)
        .map(|line| {
            let style = if line.starts_with('+') {
                Style::default().fg(TuiColor::Green)
            } else if line.starts_with('-') {
                Style::default().fg(TuiColor::Red)
            } else {
                Style::default()
            };
            Line::from(Span::styled(line.as_str(), style))
        })
        .collect();

    let content = Paragraph::new(content_lines)
        .block(Block::default().borders(Borders::ALL).title(" diff "))
        .wrap(Wrap { trim: false });
    f.render_widget(content, chunks[1]);
}

pub fn run_diff_interactive(
    a_root: PathBuf,
    b_root: PathBuf,
    a_label: String,
    b_label: String,
    entries: Vec<crate::diff::DiffEntry>,
) -> anyhow::Result<()> {
    progress_off();

    terminal::enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, terminal::EnterAlternateScreen, cursor::Hide)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = DiffApp::new(a_root, b_root, a_label, b_label, entries);

    loop {
        terminal.draw(|f| diff_ui(f, &mut app))?;
        if event::poll(std::time::Duration::from_millis(50))? {
            if let Event::Key(key) = event::read()? {
                app.handle_key(key);
            }
        }
        if app.quit { break; }
    }

    terminal::disable_raw_mode()?;
    execute!(terminal.backend_mut(), terminal::LeaveAlternateScreen, cursor::Show)?;
    progress_reset();
    Ok(())
}
