window.__ModuleLoader__.load({
  id: 'dsh-local-market',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const name = 'dsh-local-market';
    const inject = ['slots'];

    function MarketFrame() {
      const resetScroll = (event) => {
        try {
          const frame = event.currentTarget;
          frame.contentWindow.scrollTo(0, 0);
          const page = frame.contentDocument.querySelector('.page-scroll');
          if (page) page.scrollTop = 0;
        } catch (_) {}
      };
      return h('iframe', {
        src: '/dsh-local-market/',
        title: '中文插件市场',
        allow: 'clipboard-write',
        onLoad: resetScroll,
        style: {
          width: '100%',
          height: 'calc(100vh - 172px)',
          minHeight: '560px',
          border: '0',
          display: 'block',
          background: '#060a12',
          borderRadius: '10px',
        },
      });
    }

    function apply(ctx) {
      ctx.slots.inject('plugins.tab', () => ctx.slots.register({
        name: 'plugins.tab',
        id: name,
        order: -2,
        label: () => '中文市场',
        inject: () => ({}),
      }, MarketFrame));
    }

    const module = { exports: {} };
    module.exports.name = name;
    module.exports.inject = inject;
    module.exports.apply = apply;
    return module.exports;
  },
});
