import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		host: true,
		proxy: {
			'/api/metrics': {
				target: 'http://localhost:9182',
				changeOrigin: true,
				configure: (proxy, options) => {
					proxy.on('proxyReq', (proxyReq, req) => {
						const targetUrl = req.headers['x-target-url'];
						if (targetUrl) {
							const targetUrlObj = new URL(targetUrl as string);
							options.target = targetUrlObj.origin;
							proxyReq.path = '/metrics';
						}
					});
				}
			}
		}
	}
});
