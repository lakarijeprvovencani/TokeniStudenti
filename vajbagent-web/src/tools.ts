export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Kreiraj ili prepisi fajl. Sadrzaj mora biti kompletan.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Putanja do fajla' },
          content: { type: 'string', description: 'Kompletan sadrzaj fajla' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Procitaj sadrzaj fajla.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Putanja do fajla' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description: 'Prikazi listu fajlova u folderu.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Putanja do foldera' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'replace_in_file',
      description: 'Zameni deo teksta u fajlu.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Putanja do fajla' },
          old_text: { type: 'string', description: 'Tekst koji se menja' },
          new_text: { type: 'string', description: 'Novi tekst' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'execute_command',
      description: 'Izvrsi komandu u terminalu.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Komanda za izvrsavanje' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_files',
      description: 'Search for a regex pattern across files in a directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to search in' },
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          file_glob: { type: 'string', description: 'Optional glob to filter files (e.g. "*.ts")' },
        },
        required: ['path', 'pattern'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'fetch_url',
      description: 'Fetch content from a URL. Returns the response body as text (HTML, JSON, etc). Useful for reading documentation, APIs, or web pages.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
          method: { type: 'string', description: 'HTTP method (default GET)', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
          headers: { type: 'object', description: 'Optional HTTP headers as key-value pairs' },
          body: { type: 'string', description: 'Optional request body (for POST/PUT)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description: 'Search the internet for current information. Use for latest docs, library versions, error messages, APIs, news, or anything that may have changed after your training. Returns a summary answer and top search results with URLs.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
          max_results: { type: 'integer', description: 'Max number of results (1-10, default 5)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_images',
      description: 'Search Unsplash for high-quality, free-to-use stock images. Returns direct image URLs with photographer credits. Use this when the user needs topic-specific images for websites, apps, or designs. Then use download_file to save each image locally.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query in English (e.g. "dental clinic smiling woman", "modern restaurant interior")' },
          count: { type: 'integer', description: 'Number of images to return (1-10, default 5)' },
          orientation: { type: 'string', description: 'Image orientation', enum: ['landscape', 'portrait', 'squarish'] },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'supabase_list_tables',
      description: 'List all tables in the user\'s connected Supabase database (public schema). Use this to see what tables exist in the database. Only works if user has connected Supabase via OAuth and selected a project.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'supabase_describe_table',
      description: 'Get column details (name, type, nullable, default) for a specific table in the Supabase database. Use before writing code that queries a table to know its schema.',
      parameters: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name' },
        },
        required: ['table'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'supabase_get_auth_config',
      description: 'Get the user\'s Supabase auth configuration: site URL, redirect URLs, enabled OAuth providers (Google, GitHub, etc.), email confirmation settings, JWT expiry, password requirements. Use to check current auth setup before making changes.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'supabase_list_functions',
      description: 'List all edge functions deployed on the user\'s Supabase project. Returns array of { slug, name, status, version, created_at }. Use before deploying to check what exists.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'supabase_deploy_function',
      description: 'Deploy (create or update) a Supabase edge function (Deno runtime). Use for serverless backend logic: webhooks, API endpoints, scheduled tasks, Stripe webhooks, AI calls, etc. Function runs at https://{PROJECT_REF}.supabase.co/functions/v1/{slug}. Deno imports work via URLs (import { serve } from "https://deno.land/std/http/server.ts"). Use Deno.env.get("SUPABASE_URL") for env vars.',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Function slug (URL-safe name, e.g. "hello-world", "stripe-webhook")' },
          name: { type: 'string', description: 'Human-readable name (optional, defaults to slug)' },
          body: { type: 'string', description: 'Full TypeScript/Deno code. Must export default handler via serve() from std/http.' },
          verify_jwt: { type: 'boolean', description: 'Require valid Supabase JWT to call this function (default true). Set false for public endpoints like webhooks.' },
        },
        required: ['slug', 'body'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'supabase_delete_function',
      description: 'Delete an edge function by slug.',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Function slug to delete' },
        },
        required: ['slug'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'supabase_update_auth_config',
      description: 'Update Supabase auth configuration. Pass a config object with fields you want to change. Common fields: SITE_URL (string), URI_ALLOW_LIST (string with comma-separated URLs), DISABLE_SIGNUP (boolean), MAILER_AUTOCONFIRM (boolean - skip email verification), EXTERNAL_GOOGLE_ENABLED (boolean), EXTERNAL_GOOGLE_CLIENT_ID (string), EXTERNAL_GOOGLE_SECRET (string), EXTERNAL_GITHUB_ENABLED, EXTERNAL_GITHUB_CLIENT_ID, EXTERNAL_GITHUB_SECRET, JWT_EXP (number, seconds), PASSWORD_MIN_LENGTH (number), MAILER_OTP_EXP (number).',
      parameters: {
        type: 'object',
        properties: {
          config: {
            type: 'object',
            description: 'Partial auth config object — only fields you want to change',
          },
        },
        required: ['config'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'supabase_sql',
      description: 'Execute SQL directly on the user\'s Supabase database. Use for: CREATE TABLE, ALTER TABLE, INSERT, UPDATE, DELETE, SELECT, CREATE INDEX, ENABLE RLS, CREATE POLICY, etc. Returns rows or success status. This runs on the real database — be careful with destructive operations.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'SQL query to execute (PostgreSQL syntax)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'download_file',
      description: 'Download a file (image, font, etc.) from a URL and save it to the project. Use this for binary files like images from Unsplash, icons, fonts, etc.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Direct URL to the file to download' },
          path: { type: 'string', description: 'Path to save the file (e.g. "images/hero.jpg")' },
          expected_type: { type: 'string', description: 'Expected file type for verification', enum: ['image', 'application/pdf', 'font', 'any'] },
        },
        required: ['url', 'path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'git_status',
      description: 'Proveri da li je korisnik povezao GitHub nalog i vrati username. Pozovi ovo pre git_push da budes siguran da je konekcija aktivna.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'git_list_repos',
      description: 'Lista GitHub repozitorijuma korisnika (max 30 skorasnjih). Koristi ovo da nadjes ime repoa pre git_push.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'git_push',
      description: 'Push-uje trenutno stanje projekta na GitHub repozitorijum. Automatski preskace .env, kljuceve, node_modules i druge secret/build fajlove. Ako repo ne postoji, kreira ga. Koristi git_status prvo da potvrdis konekciju.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Ime repozitorijuma (samo name, bez owner/). Npr. "moj-sajt".' },
          message: { type: 'string', description: 'Commit poruka (kratko opisi izmenu).' },
          create_if_missing: { type: 'boolean', description: 'Ako je true i repo ne postoji, kreira ga kao private. Default: true.' },
        },
        required: ['repo', 'message'],
      },
    },
  },
]
