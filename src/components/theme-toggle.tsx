import { useTheme } from '../contexts/theme-context';

// Theme toggle is disabled - light mode only
export function ThemeToggle() {
  // Keep the hook call to avoid breaking any dependencies
  useTheme();

  // Return null - no theme toggle UI needed for light-only mode
  return null;
}