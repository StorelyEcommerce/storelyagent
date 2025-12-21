/**
 * Domain Settings Card Component
 * Allows users to check domain availability, buy a domain, and connect domains to stores
 */

import { useState, useEffect } from 'react';
import { Globe, ExternalLink, RefreshCw, Trash2, Link2, Unlink, Search, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
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
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import type { UserDomainData, DomainCheckData, AppsListData, DomainConnectData } from '@/api-types';

interface DomainSettingsCardProps {
    className?: string;
}

export function DomainSettingsCard({ className }: DomainSettingsCardProps) {
    const [domains, setDomains] = useState<UserDomainData[]>([]);
    const [apps, setApps] = useState<AppsListData['apps']>([]);
    const [loading, setLoading] = useState(true);

    // Domain search state
    const [searchDomain, setSearchDomain] = useState('');
    const [checking, setChecking] = useState(false);
    const [checkResult, setCheckResult] = useState<DomainCheckData | null>(null);

    // Connect domain dialog state
    const [addDialogOpen, setAddDialogOpen] = useState(false);
    const [newDomain, setNewDomain] = useState('');
    const [selectedAppId, setSelectedAppId] = useState<string>('');
    const [connecting, setConnecting] = useState(false);
    const [connectResult, setConnectResult] = useState<DomainConnectData | null>(null);
    const [manualDialogOpen, setManualDialogOpen] = useState(false);

    // Link domain dialog state
    const [linkDialogOpen, setLinkDialogOpen] = useState(false);
    const [linkingDomain, setLinkingDomain] = useState<UserDomainData | null>(null);
    const [linkAppId, setLinkAppId] = useState<string>('');
    const [linking, setLinking] = useState(false);

    // Load user's domains and apps
    useEffect(() => {
        loadDomains();
        loadApps();
    }, []);

    const loadDomains = async () => {
        try {
            setLoading(true);
            const response = await apiClient.getUserDomains();
            if (response.success && response.data) {
                setDomains(response.data.domains);
            }
        } catch (error) {
            console.error('Error loading domains:', error);
        } finally {
            setLoading(false);
        }
    };

    const loadApps = async () => {
        try {
            const response = await apiClient.getUserApps();
            if (response.success && response.data) {
                setApps(response.data.apps);
            }
        } catch (error) {
            console.error('Error loading apps:', error);
        }
    };

    const handleCheckAvailability = async () => {
        if (!searchDomain.trim()) return;

        try {
            setChecking(true);
            setCheckResult(null);
            const response = await apiClient.checkDomainAvailability(searchDomain);
            if (response.success && response.data) {
                setCheckResult(response.data);
            }
        } catch (error) {
            console.error('Error checking domain:', error);
            toast.error('Failed to check domain availability');
        } finally {
            setChecking(false);
        }
    };

    const handlePurchaseLink = async () => {
        if (!checkResult?.domain) return;

        try {
            const response = await apiClient.getDomainPurchaseUrl(checkResult.domain);
            if (response.success && response.data?.url) {
                window.open(response.data.url, '_blank');
            }
        } catch (error) {
            console.error('Error getting purchase URL:', error);
            toast.error('Failed to get purchase link');
        }
    };

    const handleConnectDomain = async () => {
        if (!newDomain.trim() || !selectedAppId) {
            toast.error('Domain and store are required');
            return;
        }

        try {
            setConnecting(true);
            setConnectResult(null);
            const response = await apiClient.connectDomain(newDomain, selectedAppId);
            if (response.success && response.data) {
                const result = response.data;
                toast.success('Domain added. Continue setup to finish DNS');
                setAddDialogOpen(false);
                setNewDomain('');
                setSelectedAppId('');
                loadDomains();
                setConnectResult(result);

                if (result.mode === 'domain-connect' && result.applyUrl) {
                    window.open(result.applyUrl, '_blank');
                    toast.info('Approve DNS changes with your domain provider, then return here.');
                } else {
                    setManualDialogOpen(true);
                }
            }
        } catch (error) {
            console.error('Error adding domain:', error);
            toast.error('Failed to connect domain');
        } finally {
            setConnecting(false);
        }
    };

    const handleLinkDomain = async () => {
        if (!linkingDomain || !linkAppId) return;

        try {
            setLinking(true);
            const response = await apiClient.linkDomainToStore(linkingDomain.id, linkAppId);
            if (response.success) {
                toast.success('Domain linked to store');
                setLinkDialogOpen(false);
                setLinkingDomain(null);
                setLinkAppId('');
                loadDomains();
            }
        } catch (error) {
            console.error('Error linking domain:', error);
            toast.error('Failed to link domain');
        } finally {
            setLinking(false);
        }
    };

    const handleUnlinkDomain = async (domain: UserDomainData) => {
        try {
            const response = await apiClient.unlinkDomainFromStore(domain.id);
            if (response.success) {
                toast.success('Domain unlinked from store');
                loadDomains();
            }
        } catch (error) {
            console.error('Error unlinking domain:', error);
            toast.error('Failed to unlink domain');
        }
    };

    const handleDeleteDomain = async (domain: UserDomainData) => {
        try {
            const response = await apiClient.deleteDomain(domain.id);
            if (response.success) {
                toast.success('Domain removed');
                loadDomains();
            }
        } catch (error) {
            console.error('Error deleting domain:', error);
            toast.error('Failed to remove domain');
        }
    };

    const getStatusBadge = (status: string) => {
        switch (status) {
            case 'active':
                return <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Active</Badge>;
            case 'verified':
                return <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">Verified</Badge>;
            case 'pending':
                return <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">Pending</Badge>;
            case 'expired':
                return <Badge className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">Expired</Badge>;
            default:
                return null;
        }
    };

    return (
        <Card className={className}>
            <CardHeader variant="minimal">
                <div className="flex items-center gap-3 border-b w-full py-3 text-text-primary">
                    <Globe className="h-5 w-5" />
                    <CardTitle className="text-base font-semibold">Custom Domains</CardTitle>
                </div>
            </CardHeader>
            <CardContent className="space-y-6">
                {/* Domain Search Section */}
                <div className="space-y-3">
                    <Label>Check Domain Availability</Label>
                    <div className="flex gap-2">
                        <Input
                            placeholder="Enter domain (e.g., mystore.com)"
                            value={searchDomain}
                            onChange={(e) => setSearchDomain(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleCheckAvailability()}
                        />
                        <Button
                            onClick={handleCheckAvailability}
                            disabled={checking || !searchDomain.trim()}
                            className="gap-2"
                        >
                            {checking ? (
                                <RefreshCw className="h-4 w-4 animate-spin" />
                            ) : (
                                <>
                                    <Search className="h-4 w-4" />
                                    Check
                                </>
                            )}
                        </Button>
                    </div>

                    {/* Check Result */}
                    {checkResult && (
                        <div className={`p-4 rounded-lg border ${checkResult.available ? 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800' : 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'}`}>
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    {checkResult.available ? (
                                        <Check className="h-5 w-5 text-green-600" />
                                    ) : (
                                        <X className="h-5 w-5 text-red-600" />
                                    )}
                                    <span className="font-medium">{checkResult.domain}</span>
                                    <span className={checkResult.available ? 'text-green-700' : 'text-red-700'}>
                                        {checkResult.available ? 'Available!' : 'Not available'}
                                    </span>
                                </div>
                                {checkResult.available ? (
                                    <Button
                                        size="sm"
                                        onClick={handlePurchaseLink}
                                        className="gap-1"
                                    >
                                        <ExternalLink className="h-4 w-4" />
                                        Buy a Domain
                                    </Button>
                                ) : (
                                    <span className="text-sm text-text-tertiary">
                                        Own it already? Connect it below.
                                    </span>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* Add Domain Button */}
                <div className="flex justify-between items-center border-t pt-4">
                    <div>
                        <p className="font-medium">Your Domains</p>
                        <p className="text-sm text-text-tertiary">
                            Connect a domain and we will handle DNS automatically when supported
                        </p>
                    </div>
                    <Button
                        variant="outline"
                        onClick={() => setAddDialogOpen(true)}
                        className="gap-2"
                    >
                        <Globe className="h-4 w-4" />
                        Connect Domain
                    </Button>
                </div>

                {/* Domain List */}
                {loading ? (
                    <div className="flex items-center justify-center py-8">
                        <RefreshCw className="h-5 w-5 animate-spin text-text-tertiary" />
                    </div>
                ) : domains.length === 0 ? (
                    <div className="text-center py-8 border-2 border-dashed rounded-lg">
                        <Globe className="h-8 w-8 text-text-tertiary mx-auto mb-2" />
                        <p className="text-sm text-text-tertiary">
                            No domains linked yet. Buy a domain anywhere, then connect it here.
                        </p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {domains.map((domain) => (
                            <div
                                key={domain.id}
                                className="flex items-center justify-between p-4 border rounded-lg bg-bg-4"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="h-10 w-10 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center">
                                        <Globe className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <p className="font-medium">{domain.domain}</p>
                                            {getStatusBadge(domain.status)}
                                        </div>
                                        {domain.app ? (
                                            <p className="text-sm text-text-tertiary">
                                                Linked to: <span className="text-text-secondary">{domain.app.title}</span>
                                            </p>
                                        ) : (
                                            <p className="text-sm text-text-tertiary">Not linked to a store</p>
                                        )}
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    {domain.app ? (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => handleUnlinkDomain(domain)}
                                            className="gap-1"
                                        >
                                            <Unlink className="h-4 w-4" />
                                            Unlink
                                        </Button>
                                    ) : (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => {
                                                setLinkingDomain(domain);
                                                setLinkDialogOpen(true);
                                            }}
                                            className="gap-1"
                                        >
                                            <Link2 className="h-4 w-4" />
                                            Link to Store
                                        </Button>
                                    )}
                                    <AlertDialog>
                                        <AlertDialogTrigger asChild>
                                            <Button variant="outline" size="sm">
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </AlertDialogTrigger>
                                        <AlertDialogContent>
                                            <AlertDialogHeader>
                                                <AlertDialogTitle>Remove Domain?</AlertDialogTitle>
                                                <AlertDialogDescription>
                                                    This will remove {domain.domain} from your account. The domain itself will not be affected.
                                                </AlertDialogDescription>
                                            </AlertDialogHeader>
                                            <AlertDialogFooter>
                                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                                <AlertDialogAction onClick={() => handleDeleteDomain(domain)}>
                                                    Remove
                                                </AlertDialogAction>
                                            </AlertDialogFooter>
                                        </AlertDialogContent>
                                    </AlertDialog>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </CardContent>

            {/* Add Domain Dialog */}
            <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Connect Domain</DialogTitle>
                        <DialogDescription>
                            Enter a domain you own and we will handle DNS automatically when possible.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <Label>Domain Name</Label>
                            <Input
                                placeholder="mystore.com"
                                value={newDomain}
                                onChange={(e) => setNewDomain(e.target.value)}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Link to Store</Label>
                            <Select value={selectedAppId} onValueChange={setSelectedAppId}>
                                <SelectTrigger>
                                    <SelectValue placeholder="Select a store" />
                                </SelectTrigger>
                                <SelectContent>
                                    {apps.map((app) => (
                                        <SelectItem key={app.id} value={app.id}>
                                            {app.title}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleConnectDomain} disabled={connecting || !newDomain.trim() || !selectedAppId}>
                            {connecting ? <RefreshCw className="h-4 w-4 animate-spin" /> : 'Connect Domain'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Manual DNS Dialog */}
            <Dialog open={manualDialogOpen} onOpenChange={setManualDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Manual DNS Setup</DialogTitle>
                        <DialogDescription>
                            We could not complete Domain Connect for this provider. Add the CNAME records below.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3 py-4 text-sm">
                        <div className="rounded-lg border border-border-primary bg-bg-3/50 p-3">
                            <p className="font-medium text-text-primary">CNAME @</p>
                            <p className="text-text-tertiary">{connectResult?.targetHost}</p>
                        </div>
                        <div className="rounded-lg border border-border-primary bg-bg-3/50 p-3">
                            <p className="font-medium text-text-primary">CNAME www</p>
                            <p className="text-text-tertiary">{connectResult?.targetHost}</p>
                        </div>
                        <p className="text-text-tertiary">
                            DNS changes can take up to 24 hours to propagate. Your domain will show as pending until it resolves.
                        </p>
                    </div>
                    <DialogFooter>
                        <Button onClick={() => setManualDialogOpen(false)}>
                            Done
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Link Domain Dialog */}
            <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Link Domain to Store</DialogTitle>
                        <DialogDescription>
                            Choose which store to link {linkingDomain?.domain} to.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <Label>Select Store</Label>
                            <Select value={linkAppId} onValueChange={setLinkAppId}>
                                <SelectTrigger>
                                    <SelectValue placeholder="Select a store" />
                                </SelectTrigger>
                                <SelectContent>
                                    {apps.map((app) => (
                                        <SelectItem key={app.id} value={app.id}>
                                            {app.title}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setLinkDialogOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleLinkDomain} disabled={linking || !linkAppId}>
                            {linking ? <RefreshCw className="h-4 w-4 animate-spin" /> : 'Link Domain'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Card>
    );
}
