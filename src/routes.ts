import type { RouteObject } from 'react-router';
import React from 'react';

import App from './App';
import Home from './routes/home';
import { ProtectedRoute } from './routes/protected-route';

const routes = [
	{
		path: '/',
		Component: App,
		children: [
			{
				index: true,
				Component: Home,
			},
			{
				path: 'chat/:chatId',
				lazy: async () => {
					const { default: Chat } = await import('./routes/chat/chat');
					return { Component: Chat };
				},
			},
			{
				path: 'profile',
				lazy: async () => {
					const { default: Profile } = await import('./routes/profile');
					return {
						Component: () =>
							React.createElement(ProtectedRoute, {
								children: React.createElement(Profile),
							}),
					};
				},
			},
			{
				path: 'settings',
				lazy: async () => {
					const { default: Settings } = await import('./routes/settings/index');
					return {
						Component: () =>
							React.createElement(ProtectedRoute, {
								children: React.createElement(Settings),
							}),
					};
				},
			},
			{
				path: 'apps',
				lazy: async () => {
					const { default: AppsPage } = await import('./routes/apps');
					return {
						Component: () =>
							React.createElement(ProtectedRoute, {
								children: React.createElement(AppsPage),
							}),
					};
				},
			},
			{
				path: 'app/:id',
				lazy: async () => {
					const { default: AppView } = await import('./routes/app');
					return { Component: AppView };
				},
			},
			{
				path: 'discover',
				lazy: async () => {
					const { default: DiscoverPage } = await import('./routes/discover');
					return { Component: DiscoverPage };
				},
			},
			{
				path: 'admin',
				lazy: async () => {
					const { default: AdminDashboard } = await import('./routes/admin');
					return {
						Component: () =>
							React.createElement(ProtectedRoute, {
								children: React.createElement(AdminDashboard),
							}),
					};
				},
			},
			{
				path: 'docs',
				lazy: async () => {
					const { default: DocsPage } = await import('./routes/docs');
					return { Component: DocsPage };
				},
			},
		],
	},
] satisfies RouteObject[];

export { routes };
