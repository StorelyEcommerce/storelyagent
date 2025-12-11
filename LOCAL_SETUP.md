# Running Storely Agent Locally

After updating the template repository in `wrangler.jsonc`, follow these steps to run locally:

## Quick Start

### 1. Install Dependencies

```bash
bun install
# or
npm install
```

### 2. Run Setup Script

The setup script will:
- Clone your template repository
- Deploy templates to local R2 bucket
- Set up database migrations
- Configure local development environment

```bash
bun run setup
# or
npm run setup
```

**What happens during setup:**
- ✅ Clones your template repository from `TEMPLATES_REPOSITORY` in `wrangler.jsonc`
- ✅ Runs `deploy_templates.sh` from your template repo
- ✅ Uploads `template_catalog.json` and template zip files to local R2
- ✅ Sets up D1 database locally
- ✅ Configures other Cloudflare resources

### 3. Start Development Server

```bash
bun run dev
# or
npm run dev
```

Visit `http://localhost:5173` to access the application locally.

## Manual Template Deployment (If Setup Fails)

If the setup script doesn't deploy templates automatically, you can do it manually:

### Option 1: Using Setup Script (Recommended)

The setup script should handle this automatically, but if templates aren't deployed:

```bash
bun run setup
```

The script will detect if templates need deployment and handle it.

### Option 2: Manual Deployment

1. **Clone your template repository:**
   ```bash
   cd templates
   git clone <your-template-repo-url> .
   cd ..
   ```

2. **Run the deploy script from your template repo:**
   ```bash
   cd templates
   chmod +x deploy_templates.sh
   
   # For local R2 deployment
   LOCAL_R2=true \
   BUCKET_NAME=vibesdk-templates \
   R2_BUCKET_NAME=vibesdk-templates \
   ./deploy_templates.sh
   ```

   **Note:** For local R2, you typically don't need `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` - Wrangler handles local R2 automatically.

3. **Verify templates are deployed:**
   ```bash
   # Check if template_catalog.json exists in local R2
   wrangler r2 object get vibesdk-templates/template_catalog.json --local
   ```

## Troubleshooting

### Templates Not Found

If you get errors about templates not being found:

1. **Check template repository URL:**
   ```bash
   # Verify TEMPLATES_REPOSITORY in wrangler.jsonc
   cat wrangler.jsonc | grep TEMPLATES_REPOSITORY
   ```

2. **Verify template catalog exists:**
   ```bash
   # Check if template_catalog.json is in your repo
   ls templates/template_catalog.json
   ```

3. **Check deploy script exists:**
   ```bash
   ls templates/deploy_templates.sh
   ```

4. **Manually verify R2 bucket:**
   ```bash
   # List objects in local R2 bucket
   wrangler r2 object list vibesdk-templates --local
   ```

### Template Deployment Fails

If `deploy_templates.sh` fails:

1. **Check script permissions:**
   ```bash
   chmod +x templates/deploy_templates.sh
   ```

2. **Run script manually with debug:**
   ```bash
   cd templates
   bash -x deploy_templates.sh
   ```

3. **Verify template structure:**
   - Ensure `template_catalog.json` exists
   - Ensure template directories exist under `templates/`
   - Ensure zip files can be created

### Local R2 Not Working

If local R2 operations fail:

1. **Check Wrangler version:**
   ```bash
   wrangler --version
   # Should be 4.x or later
   ```

2. **Verify bucket configuration in wrangler.jsonc:**
   ```jsonc
   "r2_buckets": [
     {
       "binding": "TEMPLATES_BUCKET",
       "bucket_name": "vibesdk-templates",
       "remote": false
     }
   ]
   ```

3. **Try creating bucket manually:**
   ```bash
   # This usually isn't needed - Wrangler creates buckets automatically
   wrangler r2 bucket create vibesdk-templates --local
   ```

## Development Workflow

### Daily Development

1. **Start dev server:**
   ```bash
   bun run dev
   ```

2. **Make changes** to your code

3. **Test locally** at `http://localhost:5173`

### After Template Repository Changes

If you update your template repository:

1. **Pull latest templates:**
   ```bash
   cd templates
   git pull
   cd ..
   ```

2. **Redeploy templates:**
   ```bash
   cd templates
   LOCAL_R2=true \
   BUCKET_NAME=vibesdk-templates \
   R2_BUCKET_NAME=vibesdk-templates \
   ./deploy_templates.sh
   cd ..
   ```

3. **Restart dev server:**
   ```bash
   bun run dev
   ```

## Database Commands

### Local Database

```bash
# Run migrations locally
bun run db:migrate:local

# Open Drizzle Studio (database GUI)
bun run db:studio

# Generate new migration
bun run db:generate
```

## Useful Commands

```bash
# Type checking
bun run typecheck

# Linting
bun run lint

# Build for production
bun run build

# Preview production build locally
bun run preview
```

## Environment Variables

For local development, create `.dev.vars` file (see `.dev.vars.example`):

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your API keys
```

Required variables:
- `OPENAI_API_KEY` or other AI provider keys
- `CLOUDFLARE_API_TOKEN` (for remote operations)
- `CLOUDFLARE_ACCOUNT_ID` (for remote operations)

**Note:** For local R2 operations, you typically don't need Cloudflare credentials - Wrangler handles local resources automatically.

