import { useState } from 'react';
import { ChevronDown, Store, CreditCard, Globe, ArrowRight, CheckCircle2 } from 'lucide-react';
import { useNavigate } from 'react-router';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface AccordionItemProps {
    title: string;
    icon: React.ReactNode;
    children: React.ReactNode;
    isOpen: boolean;
    onToggle: () => void;
}

function AccordionItem({ title, icon, children, isOpen, onToggle }: AccordionItemProps) {
    return (
        <div className="border border-border-primary rounded-xl overflow-hidden bg-bg-4/50">
            <button
                onClick={onToggle}
                className="w-full flex items-center justify-between p-5 text-left hover:bg-bg-4/80 transition-colors"
            >
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-accent/10 text-accent">
                        {icon}
                    </div>
                    <span className="text-lg font-medium text-text-primary">{title}</span>
                </div>
                <ChevronDown
                    className={cn(
                        "h-5 w-5 text-text-tertiary transition-transform duration-200",
                        isOpen && "rotate-180"
                    )}
                />
            </button>
            <div
                className={cn(
                    "overflow-hidden transition-all duration-300",
                    isOpen ? "max-h-[2000px] opacity-100" : "max-h-0 opacity-0"
                )}
            >
                <div className="px-5 pb-5 pt-2 space-y-4 text-text-secondary">
                    {children}
                </div>
            </div>
        </div>
    );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
    return (
        <div className="flex gap-4">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-accent text-white flex items-center justify-center font-semibold text-sm">
                {number}
            </div>
            <div className="flex-1">
                <h4 className="font-medium text-text-primary mb-1">{title}</h4>
                <p className="text-text-secondary text-sm leading-relaxed">{children}</p>
            </div>
        </div>
    );
}

function FeatureItem({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
            <span className="text-sm">{children}</span>
        </div>
    );
}

export default function DocsPage() {
    const navigate = useNavigate();
    const [openSection, setOpenSection] = useState<string | null>('getting-started');

    const toggleSection = (section: string) => {
        setOpenSection(openSection === section ? null : section);
    };

    return (
        <div className="min-h-screen bg-bg-3">
            <main className="container mx-auto px-4 py-8 max-w-4xl">
                <div className="space-y-8">
                    {/* Page Header */}
                    <div className="text-center mb-12">
                        <h1 className="text-4xl font-bold font-[departureMono] text-red-500 mb-3">
                            DOCUMENTATION
                        </h1>
                        <p className="text-text-tertiary text-lg max-w-2xl mx-auto">
                            Learn how to create your online store, accept payments with Stripe, and set up custom domains.
                        </p>
                    </div>

                    {/* Quick Actions */}
                    <div className="flex flex-wrap gap-3 justify-center mb-8">
                        <Button
                            variant="outline"
                            onClick={() => navigate('/')}
                            className="gap-2"
                        >
                            <Store className="h-4 w-4" />
                            Create Your Store
                            <ArrowRight className="h-4 w-4" />
                        </Button>
                        <Button
                            variant="outline"
                            onClick={() => navigate('/settings')}
                            className="gap-2"
                        >
                            <CreditCard className="h-4 w-4" />
                            Connect Stripe
                        </Button>
                        <Button
                            variant="outline"
                            onClick={() => navigate('/settings')}
                            className="gap-2"
                        >
                            <Globe className="h-4 w-4" />
                            Set Up Domain
                        </Button>
                    </div>

                    {/* Documentation Sections */}
                    <div className="space-y-4">
                        {/* Getting Started */}
                        <AccordionItem
                            title="Getting Started"
                            icon={<Store className="h-5 w-5" />}
                            isOpen={openSection === 'getting-started'}
                            onToggle={() => toggleSection('getting-started')}
                        >
                            <p className="text-sm leading-relaxed mb-4">
                                Storely uses AI to create a complete, deployable e-commerce store based on your description.
                                Just tell us what you want to sell, and we'll generate everything you need.
                            </p>

                            <div className="space-y-5 mb-6">
                                <Step number={1} title="Describe Your Store">
                                    Go to the home page and describe what you want to sell. Be specific about your products,
                                    brand style, and any special features you need. For example: "I want to sell handmade candles
                                    with a minimalist, cozy aesthetic."
                                </Step>
                                <Step number={2} title="Review & Customize">
                                    Watch as the AI generates your store. You can see the code being created in real-time,
                                    including your product pages, checkout flow, and admin dashboard.
                                </Step>
                                <Step number={3} title="Deploy Your Store">
                                    Once generation is complete, click "Deploy" to publish your store. You'll get a unique
                                    URL like <code className="text-xs bg-bg-3 px-1 py-0.5 rounded">your-store.storelyshop.com</code>.
                                </Step>
                                <Step number={4} title="Manage Your Store">
                                    Access your store's admin dashboard to add products, manage orders, configure settings,
                                    and track analytics.
                                </Step>
                            </div>

                            <div className="bg-accent/5 border border-accent/20 rounded-lg p-4">
                                <h4 className="font-medium text-text-primary mb-2">✨ Pro Tips</h4>
                                <ul className="text-sm space-y-1 text-text-secondary">
                                    <li>• Upload reference images to guide the design style</li>
                                    <li>• Include specific product categories you want</li>
                                    <li>• Mention any integrations you need (shipping, payments, etc.)</li>
                                </ul>
                            </div>
                        </AccordionItem>

                        {/* Stripe Integration */}
                        <AccordionItem
                            title="Stripe Connect (Payments)"
                            icon={<CreditCard className="h-5 w-5" />}
                            isOpen={openSection === 'stripe'}
                            onToggle={() => toggleSection('stripe')}
                        >
                            <p className="text-sm leading-relaxed mb-4">
                                Accept credit card payments securely through Stripe Connect. Your customers pay through Stripe,
                                and funds are deposited directly into your Stripe account.
                            </p>

                            <div className="space-y-5 mb-6">
                                <Step number={1} title="Go to Settings">
                                    Navigate to <strong>Settings</strong> from the sidebar to find the Stripe Connect section.
                                </Step>
                                <Step number={2} title="Connect Your Stripe Account">
                                    Click <strong>"Connect with Stripe"</strong>. You'll be redirected to Stripe to either
                                    create a new account or link an existing one.
                                </Step>
                                <Step number={3} title="Complete Stripe Onboarding">
                                    Follow Stripe's verification process. This includes providing business information,
                                    identity verification, and bank account details for payouts.
                                </Step>
                                <Step number={4} title="Start Accepting Payments">
                                    Once connected, your store will automatically use Stripe for checkout. All payments
                                    flow to your Stripe account minus platform fees.
                                </Step>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                                <div>
                                    <h4 className="font-medium text-text-primary mb-2">What You Get</h4>
                                    <div className="space-y-2">
                                        <FeatureItem>Secure credit/debit card processing</FeatureItem>
                                        <FeatureItem>Direct payouts to your bank</FeatureItem>
                                        <FeatureItem>Full Stripe Dashboard access</FeatureItem>
                                        <FeatureItem>Refund and dispute management</FeatureItem>
                                    </div>
                                </div>
                                <div>
                                    <h4 className="font-medium text-text-primary mb-2">Account Status</h4>
                                    <div className="space-y-2 text-sm">
                                        <p><span className="inline-block w-2 h-2 rounded-full bg-green-500 mr-2"></span><strong>Active:</strong> Fully set up, accepting payments</p>
                                        <p><span className="inline-block w-2 h-2 rounded-full bg-yellow-500 mr-2"></span><strong>Pending:</strong> Needs more info from Stripe</p>
                                        <p><span className="inline-block w-2 h-2 rounded-full bg-red-500 mr-2"></span><strong>Restricted:</strong> Action required on Stripe</p>
                                    </div>
                                </div>
                            </div>

                            <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4">
                                <h4 className="font-medium text-text-primary mb-2">💡 Note</h4>
                                <p className="text-sm text-text-secondary">
                                    You own your Stripe account. Storely never has direct access to your funds.
                                    You can manage payouts, refunds, and disputes directly through your Stripe Dashboard.
                                </p>
                            </div>
                        </AccordionItem>

                        {/* Custom Domains */}
                        <AccordionItem
                            title="Custom Domains"
                            icon={<Globe className="h-5 w-5" />}
                            isOpen={openSection === 'domains'}
                            onToggle={() => toggleSection('domains')}
                        >
                            <p className="text-sm leading-relaxed mb-4">
                                Use your own custom domain (like <code className="text-xs bg-bg-3 px-1 py-0.5 rounded">mystore.com</code>)
                                instead of the default <code className="text-xs bg-bg-3 px-1 py-0.5 rounded">store.storelyshop.com</code>.
                                Storely keeps domain ownership with you and automates DNS when your provider supports Domain Connect.
                            </p>

                            <div className="space-y-5 mb-6">
                                <Step number={1} title="Check Domain Availability">
                                    Go to <strong>Settings → Custom Domains</strong>. Enter your desired domain name
                                    and click search. We'll check if it's available for purchase.
                                </Step>
                                <Step number={2} title="Buy a Domain (Optional)">
                                    Purchase your domain from any registrar you prefer. If you need an option,
                                    the purchase link in settings will take you to a registrar checkout.
                                </Step>
                                <Step number={3} title="Connect Your Domain">
                                    Click <strong>"Connect Domain"</strong>, enter your domain, and select the store to link.
                                    Storely will attempt an automatic DNS setup using Domain Connect.
                                </Step>
                                <Step number={4} title="Approve DNS Changes">
                                    If your DNS provider supports Domain Connect, a confirmation window opens. Approve
                                    the changes and your domain will point to your Storely site. If not supported,
                                    Storely will show the manual CNAME records to add.
                                </Step>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                                <div>
                                    <h4 className="font-medium text-text-primary mb-2">What This Enables</h4>
                                    <div className="space-y-2">
                                        <FeatureItem>You own the domain directly</FeatureItem>
                                        <FeatureItem>Works with new or existing domains</FeatureItem>
                                        <FeatureItem>Automatic DNS when supported</FeatureItem>
                                        <FeatureItem>Manual CNAME fallback when needed</FeatureItem>
                                    </div>
                                </div>
                                <div>
                                    <h4 className="font-medium text-text-primary mb-2">Custom Subdomains</h4>
                                    <p className="text-sm text-text-secondary mb-2">
                                        You can also customize your free Storely subdomain:
                                    </p>
                                    <p className="text-sm">
                                        <code className="bg-bg-3 px-1 py-0.5 rounded">mystore.storelyshop.com</code>
                                        <br />
                                        <span className="text-text-tertiary text-xs">instead of v1-abc123.storelyshop.com</span>
                                    </p>
                                </div>
                            </div>

                            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-4">
                                <h4 className="font-medium text-text-primary mb-2">DNS Configuration</h4>
                                <p className="text-sm text-text-secondary">
                                    If Domain Connect is not available for your provider, Storely will show the exact CNAME
                                    records to add. Changes typically propagate within 24-48 hours.
                                </p>
                            </div>
                        </AccordionItem>
                    </div>

                    {/* Help Section */}
                    <div className="text-center pt-8 border-t border-border-primary mt-12">
                        <p className="text-text-tertiary mb-4">
                            Need more help? Have questions?
                        </p>
                        <Button
                            variant="outline"
                            onClick={() => window.open('mailto:support@storelyshop.com', '_blank')}
                        >
                            Contact Support
                        </Button>
                    </div>
                </div>
            </main>
        </div>
    );
}
