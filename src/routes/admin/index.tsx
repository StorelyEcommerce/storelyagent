/**
 * Admin Dashboard - Store Management
 * Centralized admin interface for managing multiple stores
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/contexts/auth-context';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
import { Store, Package, ShoppingCart, CreditCard, Settings, RefreshCw, ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

// Store data from platform API
interface UserStore {
    id: string;
    title: string;
    deploymentId: string | null;
    customSubdomain: string | null;
    status: string;
    createdAt: Date | null;
}

// Store-level data from store API
interface StoreProduct {
    id: string;
    title: string;
    description?: string;
    priceCents: number;
    currency: string;
    imageUrl?: string;
    stock?: number;
    isActive?: boolean;
}

interface StoreOrder {
    id: string;
    userEmail: string;
    status: string;
    totalCents: number;
    currency: string;
    createdAt?: string;
    items?: Array<{
        productId: string;
        productTitle: string;
        quantity: number;
        priceCents: number;
    }>;
}

interface StorePayment {
    id: string;
    orderId: string;
    amountCents: number;
    currency: string;
    status: string;
    createdAt?: string;
}

export default function AdminDashboard() {
    const { user } = useAuth();
    const [stores, setStores] = useState<UserStore[]>([]);
    const [selectedStoreId, setSelectedStoreId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [storeDataLoading, setStoreDataLoading] = useState(false);

    // Store-level data
    const [products, setProducts] = useState<StoreProduct[]>([]);
    const [orders, setOrders] = useState<StoreOrder[]>([]);
    const [payments, setPayments] = useState<StorePayment[]>([]);

    const selectedStore = stores.find(s => s.id === selectedStoreId);

    const loadStores = useCallback(async () => {
        try {
            setLoading(true);
            const response = await apiClient.getUserApps();
            if (response.success && response.data) {
                // Filter to only deployed stores
                const deployedStores = response.data.apps
                    .filter((app) => app.deploymentId)
                    .map((app) => ({
                        id: app.id,
                        title: app.title,
                        deploymentId: app.deploymentId,
                        customSubdomain: app.customSubdomain,
                        status: app.status,
                        createdAt: app.createdAt,
                    }));
                setStores(deployedStores);

                // Select first store by default
                if (deployedStores.length > 0) {
                    setSelectedStoreId((currentStoreId) => currentStoreId || deployedStores[0].id);
                }
            }
        } catch (error) {
            console.error('Error loading stores:', error);
            toast.error('Failed to load stores');
        } finally {
            setLoading(false);
        }
    }, []);

    const getStoreApiUrl = (store: UserStore): string => {
        if (store.customSubdomain) {
            return `https://${store.customSubdomain}.storelyshop.com`;
        }
        return `https://${store.deploymentId}.storelyshop.com`;
    };

    const loadStoreData = useCallback(async () => {
        if (!selectedStore?.deploymentId) return;

        try {
            setStoreDataLoading(true);

            // First, get the access token from the platform for cross-origin API calls
            let accessToken: string | null = null;
            try {
                const tokenResponse = await fetch('/api/auth/access-token', {
                    credentials: 'include',
                });
                if (tokenResponse.ok) {
                    const tokenData = await tokenResponse.json();
                    if (tokenData.success && tokenData.data?.accessToken) {
                        accessToken = tokenData.data.accessToken;
                    }
                }
            } catch (tokenError) {
                console.error('Failed to get access token:', tokenError);
            }

            if (!accessToken) {
                toast.error('Unable to authenticate with store. Please try logging in again.');
                return;
            }

            const storeApiUrl = getStoreApiUrl(selectedStore);

            // Fetch products, orders, and payments in parallel using JWT auth
            const [productsRes, ordersRes, paymentsRes] = await Promise.all([
                fetch(`${storeApiUrl}/v1/admin/stores/${selectedStore.id}/products`, {
                    headers: { 'Authorization': `Bearer ${accessToken}` },
                }),
                fetch(`${storeApiUrl}/v1/admin/stores/${selectedStore.id}/orders`, {
                    headers: { 'Authorization': `Bearer ${accessToken}` },
                }),
                fetch(`${storeApiUrl}/v1/admin/stores/${selectedStore.id}/payments`, {
                    headers: { 'Authorization': `Bearer ${accessToken}` },
                }),
            ]);

            if (productsRes.ok) {
                setProducts(await productsRes.json());
            }
            if (ordersRes.ok) {
                setOrders(await ordersRes.json());
            }
            if (paymentsRes.ok) {
                setPayments(await paymentsRes.json());
            }
        } catch (error) {
            console.error('Error loading store data:', error);
            toast.error('Failed to load store data. The store API may not be accessible.');
        } finally {
            setStoreDataLoading(false);
        }
    }, [selectedStore]);

    // Load user's stores from platform API
    useEffect(() => {
        loadStores();
    }, [user, loadStores]);

    // Load store data when selected store changes
    useEffect(() => {
        if (selectedStore?.deploymentId) {
            loadStoreData();
        }
    }, [selectedStore?.deploymentId, loadStoreData]);

    const formatCurrency = (cents: number, currency: string = 'usd') => {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currency.toUpperCase(),
        }).format(cents / 100);
    };

    const getStatusBadge = (status: string) => {
        const variants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
            paid: 'default',
            pending: 'secondary',
            cancelled: 'destructive',
            refunded: 'outline',
            shipped: 'default',
            delivered: 'default',
        };
        return <Badge variant={variants[status] || 'secondary'}>{status}</Badge>;
    };

    const surfaceClassName = 'rounded-[18px] border border-accent/30 dark:border-accent/50 bg-bg-4 dark:bg-bg-2 shadow-textarea';

    if (loading) {
        return (
            <div className="relative flex size-full items-center justify-center px-4 py-8">
                <div className={`${surfaceClassName} flex items-center gap-3 px-5 py-4`}>
                    <RefreshCw className="h-5 w-5 animate-spin text-accent" />
                    <span className="text-text-primary/80">Loading stores...</span>
                </div>
            </div>
        );
    }

    if (stores.length === 0) {
        return (
            <div className="relative flex size-full items-center justify-center px-4 py-8">
                <main className={`w-full max-w-2xl p-8 text-center ${surfaceClassName}`}>
                    <Store className="mx-auto mb-4 h-14 w-14 text-accent/80" />
                    <h1 className="mb-2 text-4xl font-medium tracking-tight text-text-primary">No Deployed Stores</h1>
                    <p className="mb-6 text-text-primary/70">
                            You don't have any deployed stores yet. Create and deploy a store to manage it here.
                    </p>
                    <Button onClick={() => window.location.href = '/'} className="bg-accent text-white hover:bg-accent/90">
                        Create a Store
                    </Button>
                </main>
            </div>
        );
    }

    return (
        <div className="relative flex size-full justify-center px-4 py-8">
            <main className="w-full max-w-6xl">
                <div className="space-y-6">
                    {/* Header with Store Switcher */}
                    <div className={`${surfaceClassName} flex flex-col gap-4 p-5 sm:flex-row sm:items-end sm:justify-between`}>
                        <div className="space-y-2">
                            <h1 className="bg-gradient-to-r from-text-primary to-text-primary/90 bg-clip-text text-4xl font-medium leading-[1.1] tracking-tight text-transparent md:text-5xl">
                                Store admin
                            </h1>
                            <p className="text-text-primary/70">
                                Manage your store's products, orders, and settings
                            </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-3">
                            <Select value={selectedStoreId || ''} onValueChange={setSelectedStoreId}>
                                <SelectTrigger className="w-full border-accent/30 bg-bg-3 sm:w-[280px]">
                                    <SelectValue placeholder="Select a store" />
                                </SelectTrigger>
                                <SelectContent>
                                    {stores.map((store) => (
                                        <SelectItem key={store.id} value={store.id}>
                                            <div className="flex items-center gap-2">
                                                <Store className="h-4 w-4" />
                                                <span>{store.title}</span>
                                            </div>
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>

                            {selectedStore && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => window.open(getStoreApiUrl(selectedStore), '_blank')}
                                    className="border-accent/30 bg-bg-3 hover:bg-bg-3/80"
                                >
                                    <ExternalLink className="h-4 w-4 mr-2" />
                                    View Store
                                </Button>
                            )}
                        </div>
                    </div>

                    <Separator className="bg-accent/20" />

                    {/* Stats Overview */}
                    {selectedStore && (
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                            <Card className={surfaceClassName}>
                                <CardContent className="pt-6">
                                    <div className="flex items-center gap-2">
                                        <Package className="h-5 w-5 text-accent" />
                                        <div>
                                            <p className="text-2xl font-bold">{products.length}</p>
                                            <p className="text-sm text-text-primary/70">Products</p>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                            <Card className={surfaceClassName}>
                                <CardContent className="pt-6">
                                    <div className="flex items-center gap-2">
                                        <ShoppingCart className="h-5 w-5 text-accent" />
                                        <div>
                                            <p className="text-2xl font-bold">{orders.length}</p>
                                            <p className="text-sm text-text-primary/70">Orders</p>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                            <Card className={surfaceClassName}>
                                <CardContent className="pt-6">
                                    <div className="flex items-center gap-2">
                                        <CreditCard className="h-5 w-5 text-accent" />
                                        <div>
                                            <p className="text-2xl font-bold">
                                                {formatCurrency(
                                                    payments.reduce((sum, p) => sum + p.amountCents, 0),
                                                    'usd'
                                                )}
                                            </p>
                                            <p className="text-sm text-text-primary/70">Total Revenue</p>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                            <Card className={surfaceClassName}>
                                <CardContent className="pt-6">
                                    <div className="flex items-center gap-2">
                                        <Settings className="h-5 w-5 text-accent" />
                                        <div>
                                            <p className="text-2xl font-bold capitalize">{selectedStore.status}</p>
                                            <p className="text-sm text-text-primary/70">Store Status</p>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        </div>
                    )}

                    {/* Main Content Tabs */}
                    {selectedStore && (
                        <Tabs defaultValue="products" className="space-y-4">
                            <TabsList className="border border-accent/30 bg-bg-4 dark:bg-bg-2">
                                <TabsTrigger value="products" className="gap-2">
                                    <Package className="h-4 w-4" />
                                    Products
                                </TabsTrigger>
                                <TabsTrigger value="orders" className="gap-2">
                                    <ShoppingCart className="h-4 w-4" />
                                    Orders
                                </TabsTrigger>
                                <TabsTrigger value="payments" className="gap-2">
                                    <CreditCard className="h-4 w-4" />
                                    Payments
                                </TabsTrigger>
                            </TabsList>

                            {storeDataLoading ? (
                                <div className={`${surfaceClassName} flex items-center justify-center py-12`}>
                                    <RefreshCw className="h-5 w-5 animate-spin text-accent mr-2" />
                                    <span className="text-text-primary/80">Loading store data...</span>
                                </div>
                            ) : (
                                <>
                                    {/* Products Tab */}
                                    <TabsContent value="products">
                                        <Card className={surfaceClassName}>
                                            <CardHeader>
                                                <CardTitle className="flex items-center justify-between">
                                                    <span>Products</span>
                                                    <Button
                                                        size="sm"
                                                        className="bg-accent text-white hover:bg-accent/90"
                                                        onClick={() => toast.info('Product creation coming soon!')}
                                                    >
                                                        Add Product
                                                    </Button>
                                                </CardTitle>
                                            </CardHeader>
                                            <CardContent>
                                                {products.length === 0 ? (
                                                    <div className="py-8 text-center text-text-primary/70">
                                                        <Package className="mx-auto mb-2 h-12 w-12 opacity-50" />
                                                        <p>No products yet</p>
                                                    </div>
                                                ) : (
                                                    <div className="space-y-3">
                                                        {products.map((product) => (
                                                            <div
                                                                key={product.id}
                                                                className="flex items-center justify-between rounded-lg border border-accent/20 bg-bg-3/60 p-4"
                                                            >
                                                                <div className="flex items-center gap-4">
                                                                    {product.imageUrl ? (
                                                                        <img
                                                                            src={product.imageUrl}
                                                                            alt={product.title}
                                                                            className="h-12 w-12 object-cover rounded"
                                                                        />
                                                                    ) : (
                                                                        <div className="flex h-12 w-12 items-center justify-center rounded bg-bg-2">
                                                                            <Package className="h-6 w-6 text-text-primary/60" />
                                                                        </div>
                                                                    )}
                                                                    <div>
                                                                        <p className="font-medium">{product.title}</p>
                                                                        <p className="text-sm text-text-primary/70">
                                                                            {formatCurrency(product.priceCents, product.currency)}
                                                                            {product.stock !== undefined && ` • ${product.stock} in stock`}
                                                                        </p>
                                                                    </div>
                                                                </div>
                                                                <Badge variant={product.isActive ? 'default' : 'secondary'}>
                                                                    {product.isActive ? 'Active' : 'Inactive'}
                                                                </Badge>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </CardContent>
                                        </Card>
                                    </TabsContent>

                                    {/* Orders Tab */}
                                    <TabsContent value="orders">
                                        <Card className={surfaceClassName}>
                                            <CardHeader>
                                                <CardTitle>Orders</CardTitle>
                                            </CardHeader>
                                            <CardContent>
                                                {orders.length === 0 ? (
                                                    <div className="py-8 text-center text-text-primary/70">
                                                        <ShoppingCart className="mx-auto mb-2 h-12 w-12 opacity-50" />
                                                        <p>No orders yet</p>
                                                    </div>
                                                ) : (
                                                    <div className="space-y-3">
                                                        {orders.map((order) => (
                                                            <div
                                                                key={order.id}
                                                                className="flex items-center justify-between rounded-lg border border-accent/20 bg-bg-3/60 p-4"
                                                            >
                                                                <div>
                                                                    <p className="font-medium">Order #{order.id.slice(0, 8)}</p>
                                                                    <p className="text-sm text-text-primary/70">
                                                                        {order.userEmail} • {formatCurrency(order.totalCents, order.currency)}
                                                                    </p>
                                                                    {order.items && order.items.length > 0 && (
                                                                        <p className="mt-1 text-xs text-text-primary/70">
                                                                            {order.items.length} item(s)
                                                                        </p>
                                                                    )}
                                                                </div>
                                                                {getStatusBadge(order.status)}
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </CardContent>
                                        </Card>
                                    </TabsContent>

                                    {/* Payments Tab */}
                                    <TabsContent value="payments">
                                        <Card className={surfaceClassName}>
                                            <CardHeader>
                                                <CardTitle>Payments</CardTitle>
                                            </CardHeader>
                                            <CardContent>
                                                {payments.length === 0 ? (
                                                    <div className="py-8 text-center text-text-primary/70">
                                                        <CreditCard className="mx-auto mb-2 h-12 w-12 opacity-50" />
                                                        <p>No payments yet</p>
                                                    </div>
                                                ) : (
                                                    <div className="space-y-3">
                                                        {payments.map((payment) => (
                                                            <div
                                                                key={payment.id}
                                                                className="flex items-center justify-between rounded-lg border border-accent/20 bg-bg-3/60 p-4"
                                                            >
                                                                <div>
                                                                    <p className="font-medium">
                                                                        {formatCurrency(payment.amountCents, payment.currency)}
                                                                    </p>
                                                                    <p className="text-sm text-text-primary/70">
                                                                        Order #{payment.orderId.slice(0, 8)}
                                                                        {payment.createdAt && ` • ${new Date(payment.createdAt).toLocaleDateString()}`}
                                                                    </p>
                                                                </div>
                                                                {getStatusBadge(payment.status)}
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </CardContent>
                                        </Card>
                                    </TabsContent>
                                </>
                            )}
                        </Tabs>
                    )}
                </div>
            </main>
        </div>
    );
}
