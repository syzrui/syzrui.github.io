// 定义转义字典
const dictionary = {
    status: '状态码',
    phone: '号码',
    phonediqu: '号码地区',
    message: '提示',
    qq: 'QQ号',
    name: 'QQ游戏名',
    daqu: '游戏大区',
    qqlm: '可能的老密',
    id: '微博ID'
}
// 定义API列表
const apiList = {
    queryQQToPhone: {
        name: 'qq号查询绑定手机',
        url: "https://zy.xywlapi.cc/qqapi?qq="
    },
    queryPhoneToQQ: {
        name: '手机号查询绑定qq',
        url: "https://zy.xywlapi.cc/qqphone?phone="
    },
    queryQQToLol: {
        name: 'QQ号查询LOL信息',
        url: "https://zy.xywlapi.cc/qqlol?qq="
    },
    queryLolToQQ: {
        name: 'LOL查询QQ信息',
        url: "https://zy.xywlapi.cc/lolname?name="
    },
    queryQQToLaomi: {
        name: 'QQ号查询老密(测试中)',
        url: "https://zy.xywlapi.cc/qqlm?qq="
    },
    queryWeiboToPhone: {
        name: '微博ID查手机号',
        url: "https://zy.xywlapi.cc/wbapi?id="
    },
    queryPhoneToWeibo: {
        name: '手机号查微博ID',
        url: "https://zy.xywlapi.cc/wbphone?phone="
    },
};

window.onload = () => {

    console.version('0.1.0')

    let historyArea = document.querySelector('.queryHistoryArea')
    let history = JSON.parse(getStore('history')) || []
    if (history == null || history.length == 0) {
        historyArea.innerHTML = `<div style="margin:20px auto;">暂无历史记录！</div>`
    } else {
        historyRender(history, historyArea)
    }

    let result = document.querySelector("#result");
    let submit = document.querySelector("#submit");
    submit.addEventListener("click", () => {
        let queryContent = document.querySelector("#input").value;
        let select = document.querySelector("#select");
        if (queryContent == "" || queryContent == null) {
            message({ message: '请输入内容...', type: 'warning' })
            return
        }
        requestApi(select[select.selectedIndex].value, queryContent, result);
    });
    // 具体请求方法
    const requestApi = (urlName, param, el) => {
        el.innerHTML = ''
        var loading = null
        loading = document.createElement('div')
        loading.className = 'loading'
        loading.innerHTML = '<div class="icon-icloading"></div>正在查询...'
        el.appendChild(loading)
        axios
            .get(`${apiList[urlName].url}${param}`)
            .then((res) => {
                let result = res.data

                let queryInfo = {
                    queryProject: apiList[urlName].name,
                    queryContent: param,
                    queryTime: new Date().toLocaleString(),
                    result: result
                }
                if(history.length>=10) {
                    history = history.slice(0, 9)
                }
                history.unshift(queryInfo)
                setStore('history',JSON.stringify(history))
                historyRender(history, historyArea)

                let ul = document.createElement('ul')
                for (const key in result) {
                    let li = document.createElement('li')
                    li.innerHTML = `<span>${dictionary[key]}</span>: ${result[key]}`
                    ul.appendChild(li)
                }
                loading = null
                el.innerHTML = ''
                el.appendChild(ul)
            })
            .catch((err) => {
                loading = null
                el.innerHTML = ''
                el.innerText = `${err.name}: ${err.message}`
            });
    };
};


const historyRender = (data, el) => {
    const renderHistory = (data) => {
        const renderContent = (key, data) => {
            let li = document.createElement('li')
            li.innerHTML = `<span>${dictionary[key]}</span>: ${data}`
            return li
        }
        let result = document.createElement('div')
        result.className = 'result'
        result.innerHTML = `
        <div class="result-header">
            <span>查询项目：${data.queryProject}</span>
            <span>${upTime(data.queryTime)}</span>
        </div>
        <div class="result-query-content"><span>查询内容</span>：${data.queryContent}</div>
        `
        let ul = document.createElement('ul')
        for (const key in data.result) {
            ul.appendChild(renderContent(key, data.result[key]))
        }
        result.appendChild(ul)
        return result
    }
    el.innerHTML = ''
    for (const key in data) {
        el.appendChild(renderHistory(data[key]))
    }
}