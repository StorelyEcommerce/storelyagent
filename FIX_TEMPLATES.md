# Fix: System Using Old Templates

## The Problem

The system reads templates from the **R2 bucket**, not directly from your git repository. When you changed `TEMPLATES_REPOSITORY` in `wrangler.jsonc`, the R2 bucket still contains the old templates.

## The Solution

You need to deploy your new templates to the R2 bucket. Here's how:

### Option 1: Run Setup Script (Recommended)

The setup script will clone your new repository and deploy templates:

```bash
bun run setup
```

This will:
1. Clone your new template repository
2. Run `deploy_templates.sh` 
3. Upload new `template_catalog.json` and template zips to R2
4. Replace the old templates

### Option 2: Manual Deployment

If setup doesn't work, deploy manually:

#### Step 1: Remove Old Templates (Optional but Recommended)

```bash
# List current templates in R2
wrangler r2 object list vibesdk-templates --local

# Delete old template catalog
wrangler r2 object delete vibesdk-templates/template_catalog.json --local

# Delete old template zip files (list them first, then delete)
# Example:
# wrangler r2 object delete vibesdk-templates/vite-cf-DO-v2-runner.zip --local
# wrangler r2 object delete vibesdk-templates/minimal-js.zip --local
# ... etc for each old template
```

#### Step 2: Clone Your New Template Repository

```bash
# Remove old templates directory if it exists
rm -rf templates

# Clone your new repository
git clone https://github.com/StorelyEcommerce/store-template templates
```

#### Step 3: Deploy New Templates

```bash
cd templates

# Make deploy script executable
chmod +x deploy_templates.sh

# Deploy to local R2
LOCAL_R2=true \
BUCKET_NAME=vibesdk-templates \
R2_BUCKET_NAME=vibesdk-templates \
./deploy_templates.sh

cd ..
```

#### Step 4: Verify Deployment

```bash
# Check that new template_catalog.json exists
wrangler r2 object get vibesdk-templates/template_catalog.json --local

# List all templates in R2
wrangler r2 object list vibesdk-templates --local
```

You should see:
- `template_catalog.json` (your new catalog)
- `base-store.zip` (or whatever your template is named)

### Option 3: Quick Fix - Delete and Redeploy

If you want to start fresh:

```bash
# 1. Delete all objects in local R2 bucket
wrangler r2 object list vibesdk-templates --local | grep -v "template_catalog" | awk '{print $1}' | xargs -I {} wrangler r2 object delete vibesdk-templates/{} --local
wrangler r2 object delete vibesdk-templates/template_catalog.json --local

# 2. Remove old templates directory
rm -rf templates

# 3. Run setup to clone and deploy new templates
bun run setup
```

## Verify It's Working

After deploying, restart your dev server and test:

```bash
# Restart dev server
bun run dev
```

Then try creating a new app - it should now use your `base-store` template instead of the old ones.

## Check What Templates Are Available

You can verify what templates the system sees by checking the R2 bucket:

```bash
# Download and view template catalog
wrangler r2 object get vibesdk-templates/template_catalog.json --local | jq .
```

This will show you all templates currently available to the system.

## Troubleshooting

### Templates Still Not Updating

1. **Check if you're using local vs remote R2:**
   - Local development uses `--local` flag
   - Make sure you're deploying to the correct bucket

2. **Verify template repository URL:**
   ```bash
   cat wrangler.jsonc | grep TEMPLATES_REPOSITORY
   ```
   Should show: `"TEMPLATES_REPOSITORY": "https://github.com/StorelyEcommerce/store-template"`

3. **Check deploy script exists:**
   ```bash
   ls templates/deploy_templates.sh
   ```

4. **Verify template_catalog.json format:**
   ```bash
   cat templates/template_catalog.json | jq .
   ```
   Should be valid JSON with your template(s)

### Cache Issues

If templates still don't update, there might be caching. Try:

1. **Restart dev server completely**
2. **Clear any caches** (the system may cache template details)
3. **Create a new app** (don't reuse old app instances)

