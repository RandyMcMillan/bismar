//! CLI argument parsing. Maps bismar's src/bismar.ts parseArgs / CliArgs.


#[derive(Debug, Clone, Default)]
pub struct CliArgs {
    pub bundle: bool,
    pub clear: bool,
    pub diff: bool,
    pub help: bool,
    pub interactive: bool,
    pub list: bool,
    pub minify: bool,
    pub paths: Vec<String>,
    pub size: bool,
}

pub fn parse_args(argv: &[String]) -> CliArgs {
    let mut args = CliArgs {
        interactive: true, // default when no flags given
        ..Default::default()
    };

    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        match a.as_str() {
            "--help" | "-h" => { args.help = true; args.interactive = false; }
            "--bundle" | "-b" => { args.bundle = true; args.interactive = false; }
            "--minify" | "-m" => { args.minify = true; args.interactive = false; }
            "--size" | "-s" => { args.size = true; args.interactive = false; }
            "--list" | "-l" => { args.list = true; args.interactive = false; }
            "--diff" | "-d" => { args.diff = true; args.interactive = false; }
            "--clear" => { args.clear = true; args.interactive = false; }
            other if other.starts_with('-') => {
                // Compound flags like -bs, -bsm, -dbsm, -ds, -dbs
                let flags = &other[1..];
                for ch in flags.chars() {
                    match ch {
                        'b' => { args.bundle = true; args.interactive = false; }
                        'm' => { args.minify = true; args.interactive = false; }
                        's' => { args.size = true; args.interactive = false; }
                        'l' => { args.list = true; args.interactive = false; }
                        'd' => { args.diff = true; args.interactive = false; }
                        'h' => { args.help = true; args.interactive = false; }
                        _ => {}
                    }
                }
            }
            _ => {
                args.paths.push(a.clone());
                args.interactive = false;
            }
        }
        i += 1;
    }

    // If only paths are given with no flags, use interactive mode.
    let has_flags = args.bundle || args.clear || args.diff || args.help
        || args.list || args.minify || args.size;
    if !has_flags && !args.paths.is_empty() {
        args.interactive = true;
    }
    if args.diff && args.paths.len() >= 2 {
        args.interactive = false;
    }

    args
}

pub const USAGE: &str = r#"usage:
  bismar [<selector>] [--bundle] [--minify] [--size] [--list]
  bismar [-bms] [<selector>]
  bismar --diff <a> <b>

flags:
  <no flag>     open interactive navigator
  -b, --bundle  emit a single-file bundle (JS) / archive (non-JS)
  -m, --minify  (JS only) emit the minified bundle
  -s, --size    list shipped file size stats
      -bs       (JS) bundle sizes
      -bsm      (JS) bundle sizes, minified+gzipped
  -d, --diff    interactive comparison between 2 selectors
      -ds       non-interactive size stats for all files
      -dbs      (JS) diff of bundle sizes
      -dbsm     (JS) diff of bundle sizes, minified+gzipped
  -l, --list    list all public exports
      --clear   clean-up bismar cache

selectors (package / ref / dir / archive):
  npm:qr, npm:qr@0.6, gem:sinatra, ../sinatra, ./qr.tar.bz2

namespaces ("short: long"; both versions work):
  js:   npm         py:   pypi
  jsr:  jsr         php:  packagist
  rs:   crate       gh:   github
  rb:   gem         go:   go proxy
  gitlab: gitlab

examples:
  bismar js:@noble/hashes           # vim-like pager
  bismar rs:serde
  bismar gem:sinatra/README.md
  bismar gh:@paulmillr              # user repos
  bismar gem:sinatra/lib/sinatra.rb > s.rb

  bismar -l npm:micro-ftch

  bismar -b js:qr > qr.js
  bismar -b rs:serde > serde.cargo
  bismar -bm js:qr > qr.min.js

  bismar -s js:chokidar
  bismar -bs npm:micro-ftch
  bismar -bsm npm:micro-ftch

  bismar -d js:qr@0.5 js:qr@0.6
  bismar -ds npm:readdirp@{4,5}
  bismar -dbs npm:readdirp@{4,5}
  bismar -dbsm npm:readdirp@{4,5}"#;
