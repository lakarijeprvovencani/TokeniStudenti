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
]
