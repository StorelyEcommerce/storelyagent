/**
 * Stripe Connect Card Component
 * Shows Stripe Connect status and allows connecting/disconnecting Stripe accounts
 */

import { useState, useEffect } from 'react';
import { CreditCard, ExternalLink, RefreshCw, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import type { StripeConnectStatusData } from '@/api-types';

interface StripeConnectCardProps {
    className?: string;
}

export function StripeConnectCard({ className }: StripeConnectCardProps) {
    const [status, setStatus] = useState<StripeConnectStatusData | null>(null);
    const [loading, setLoading] = useState(true);
    const [connecting, setConnecting] = useState(false);
    const [disconnecting, setDisconnecting] = useState(false);

    // Check URL params for return from Stripe
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const stripeReturn = params.get('stripe_return');
        const stripeRefresh = params.get('stripe_refresh');

        if (stripeReturn === 'true') {
            // User returned from Stripe onboarding - refresh status
            refreshStatus();
            // Clean up URL
            const url = new URL(window.location.href);
            url.searchParams.delete('stripe_return');
            window.history.replaceState({}, '', url.toString());
        } else if (stripeRefresh === 'true') {
            // Onboarding link expired - try again
            toast.info('Your onboarding session expired. Please try again.');
            const url = new URL(window.location.href);
            url.searchParams.delete('stripe_refresh');
            window.history.replaceState({}, '', url.toString());
        }
    }, []);

    // Load initial status
    useEffect(() => {
        loadStatus();
    }, []);

    const loadStatus = async () => {
        try {
            setLoading(true);
            const response = await apiClient.getStripeConnectStatus();
            if (response.success && response.data) {
                setStatus(response.data);
            }
        } catch (error) {
            console.error('Error loading Stripe status:', error);
        } finally {
            setLoading(false);
        }
    };

    const refreshStatus = async () => {
        try {
            setLoading(true);
            const response = await apiClient.refreshStripeConnectStatus();
            if (response.success && response.data) {
                setStatus(response.data);
                toast.success('Stripe account status updated');
            }
        } catch (error) {
            console.error('Error refreshing Stripe status:', error);
            // Fall back to regular status check
            await loadStatus();
        } finally {
            setLoading(false);
        }
    };

    const handleConnect = async () => {
        try {
            setConnecting(true);
            const response = await apiClient.initiateStripeConnect();
            if (response.success && response.data?.url) {
                // Redirect to Stripe onboarding
                window.location.href = response.data.url;
            } else {
                toast.error('Failed to start Stripe onboarding');
            }
        } catch (error) {
            console.error('Error initiating Stripe Connect:', error);
            toast.error('Failed to connect Stripe account');
        } finally {
            setConnecting(false);
        }
    };

    const handleOpenDashboard = async () => {
        try {
            const response = await apiClient.getStripeDashboardLink();
            if (response.success && response.data?.url) {
                window.open(response.data.url, '_blank');
            } else {
                toast.error('Failed to get dashboard link');
            }
        } catch (error) {
            console.error('Error getting dashboard link:', error);
            toast.error('Failed to open Stripe Dashboard');
        }
    };

    const handleDisconnect = async () => {
        try {
            setDisconnecting(true);
            const response = await apiClient.disconnectStripe();
            if (response.success) {
                setStatus({ isConnected: false });
                toast.success('Stripe account disconnected');
            } else {
                toast.error('Failed to disconnect Stripe account');
            }
        } catch (error) {
            console.error('Error disconnecting Stripe:', error);
            toast.error('Failed to disconnect Stripe account');
        } finally {
            setDisconnecting(false);
        }
    };

    const getStatusBadge = () => {
        if (!status?.account) return null;

        const account = status.account;
        if (account.chargesEnabled && account.detailsSubmitted) {
            return (
                <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                    Active
                </Badge>
            );
        } else if (account.status === 'pending' || !account.detailsSubmitted) {
            return (
                <Badge variant="secondary" className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
                    Pending Setup
                </Badge>
            );
        } else if (account.status === 'restricted') {
            return (
                <Badge variant="secondary" className="bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200">
                    Restricted
                </Badge>
            );
        } else if (account.status === 'disabled') {
            return (
                <Badge variant="secondary" className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">
                    Disabled
                </Badge>
            );
        }
        return null;
    };

    return (
        <Card className={className}>
            <CardHeader variant="minimal">
                <div className="flex items-center gap-3 border-b w-full py-3 text-text-primary">
                    <CreditCard className="h-5 w-5" />
                    <CardTitle className="text-base font-semibold">Payment Integration</CardTitle>
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                {loading ? (
                    <div className="flex items-center justify-center py-8">
                        <RefreshCw className="h-5 w-5 animate-spin text-text-tertiary" />
                    </div>
                ) : status?.isConnected && status.account ? (
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="h-10 w-10 rounded-full bg-[#635bff] flex items-center justify-center">
                                <span className="text-white font-bold text-sm">S</span>
                            </div>
                            <div>
                                <div className="flex items-center gap-2">
                                    <p className="font-medium">Stripe Connected</p>
                                    {getStatusBadge()}
                                </div>
                                <p className="text-sm text-text-tertiary">
                                    Account: {status.account.stripeAccountId.slice(0, 12)}...
                                    {status.account.country && ` • ${status.account.country}`}
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            {status.account.detailsSubmitted && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={handleOpenDashboard}
                                    className="gap-1"
                                >
                                    <ExternalLink className="h-4 w-4" />
                                    Dashboard
                                </Button>
                            )}
                            {!status.account.detailsSubmitted && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={handleConnect}
                                    disabled={connecting}
                                    className="gap-1"
                                >
                                    {connecting ? (
                                        <RefreshCw className="h-4 w-4 animate-spin" />
                                    ) : (
                                        'Complete Setup'
                                    )}
                                </Button>
                            )}
                            <AlertDialog>
                                <AlertDialogTrigger asChild>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={disconnecting}
                                        className="gap-1"
                                    >
                                        {disconnecting ? (
                                            <RefreshCw className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <>
                                                <Unlink className="h-4 w-4" />
                                                Disconnect
                                            </>
                                        )}
                                    </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                    <AlertDialogHeader>
                                        <AlertDialogTitle>Disconnect Stripe Account?</AlertDialogTitle>
                                        <AlertDialogDescription>
                                            This will remove your Stripe connection. Your generated stores will no longer be able to process payments until you reconnect.
                                        </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                                        <AlertDialogAction onClick={handleDisconnect}>
                                            Disconnect
                                        </AlertDialogAction>
                                    </AlertDialogFooter>
                                </AlertDialogContent>
                            </AlertDialog>
                        </div>
                    </div>
                ) : (
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="h-10 w-10 rounded-full bg-bg-2 border-bg-1 dark:border-bg-4 border flex items-center justify-center">
                                <CreditCard className="h-5 w-5 text-text-tertiary" />
                            </div>
                            <div>
                                <p className="font-medium">Connect Stripe</p>
                                <p className="text-sm text-text-tertiary">
                                    Enable payment processing for your generated stores
                                </p>
                            </div>
                        </div>
                        <Button
                            onClick={handleConnect}
                            disabled={connecting}
                            className="gap-2 bg-[#635bff] hover:bg-[#4f46e5] text-white"
                        >
                            {connecting ? (
                                <RefreshCw className="h-4 w-4 animate-spin" />
                            ) : (
                                <>
                                    <CreditCard className="h-4 w-4" />
                                    Connect Stripe
                                </>
                            )}
                        </Button>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
